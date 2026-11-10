// 悬浮窗外壳：一个不抢占前台应用的 NSPanel，里面放 WKWebView。
// 自身不含搜索逻辑：stdin 的每一行 JSON 转给页面，页面发出的每条消息写到 stdout。
import AppKit
import WebKit
import Quartz

let outLock = NSLock()
func emit(_ line: String) {
    outLock.lock()
    defer { outLock.unlock() }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

final class SearchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // 没有主菜单，⌘C/⌘V 等编辑快捷键需要手动派发给第一响应者。
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown else { return super.performKeyEquivalent(with: event) }
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if flags == .command {
            let action: Selector?
            switch key {
            case "c": action = #selector(NSText.copy(_:))
            case "v": action = #selector(NSText.paste(_:))
            case "x": action = #selector(NSText.cut(_:))
            case "a": action = #selector(NSText.selectAll(_:))
            case "z": action = Selector(("undo:"))
            default: action = nil
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        } else if flags == [.command, .shift], key == "z" {
            if NSApp.sendAction(Selector(("redo:")), to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler,
    NSWindowDelegate
{
    let uiDir: URL
    let snapshotPath: String?
    let feedPath: String?
    let delay: Double
    var panel: SearchPanel!
    var web: WKWebView!
    var loaded = false
    var pending: [String] = []
    var quickLook: QLPreviewView?
    var previewKeyMonitor: Any?

    override init() {
        uiDir = URL(fileURLWithPath: argValue("--ui") ?? ".", isDirectory: true)
        snapshotPath = argValue("--snapshot")
        feedPath = argValue("--feed")
        delay = Double(argValue("--delay") ?? "") ?? 1.2
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let size = NSSize(width: 1040, height: 640)
        panel = SearchPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.delegate = self

        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = 12
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor.separatorColor.cgColor

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bridge")
        web = WKWebView(frame: container.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        container.addSubview(web)
        panel.contentView = container
        previewKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.panel.isKeyWindow,
                let preview = self.quickLook, !preview.isHidden,
                let responder = self.panel.firstResponder as? NSView,
                responder === preview || responder.isDescendant(of: preview),
                event.modifierFlags.intersection([.command, .option, .control]).isEmpty
            else { return event }
            let keys: [UInt16: String] = [53: "Escape", 36: "Enter", 76: "Enter", 125: "ArrowDown", 126: "ArrowUp", 121: "PageDown", 116: "PageUp"]
            guard let key = keys[event.keyCode] else { return event }
            self.web.evaluateJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key: '\(key)', bubbles: true}))", completionHandler: nil)
            return nil
        }

        let index = uiDir.appendingPathComponent("index.html")
        web.loadFileURL(index, allowingReadAccessTo: uiDir)

        if snapshotPath == nil { readStdin() }
    }

    func readStdin() {
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                if line.isEmpty { continue }
                DispatchQueue.main.async { self.handle(line) }
            }
            // 父进程（插件 worker）退出后不再有存在意义。
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
            let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = message["type"] as? String
        else { return }
        switch type {
        case "quit":
            NSApp.terminate(nil)
        case "hide":
            hide()
        case "snapshot":
            if let path = message["path"] as? String { capture(to: path) {} }
        case "show":
            deliver(line) { self.show() }
        default:
            deliver(line, then: nil)
        }
    }

    func deliver(_ line: String, then: (() -> Void)?) {
        guard loaded else {
            pending.append(line)
            if let then { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { then() } }
            return
        }
        web.evaluateJavaScript("window.__recv(\(line))") { _, _ in then?() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        let queued = pending
        pending = []
        for line in queued { deliver(line, then: nil) }
        emit("{\"type\":\"ready\"}")
        if let snapshotPath { runSnapshot(to: snapshotPath) }
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String else { return }
        if let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["type"] as? String == "quicklook"
        {
            updateQuickLook(json)
            return
        }
        if text.hasPrefix("{\"type\":\"hide\"") {
            hide()
            return
        }
        emit(text)
        if text.hasPrefix("{\"type\":\"open\"") { hide() }
    }

    /// 原生文件预览覆盖右侧正文区域，保留搜索框、结果列表和路径栏。
    func updateQuickLook(_ message: [String: Any]) {
        guard message["visible"] as? Bool == true else {
            quickLook?.previewItem = nil
            quickLook?.isHidden = true
            return
        }
        guard let rawURL = message["url"] as? String,
            panel.isVisible,
            let url = URL(string: rawURL), url.isFileURL,
            let frame = message["frame"] as? [String: Double],
            let x = frame["x"], let y = frame["y"],
            let width = frame["width"], let height = frame["height"],
            width > 0, height > 0,
            let container = panel.contentView
        else { return }
        let bounds = NSRect(x: x, y: container.bounds.height - y - height, width: width, height: height)
        if quickLook == nil {
            quickLook = QLPreviewView(frame: bounds, style: .normal)
            quickLook?.autostarts = false
            if let quickLook { container.addSubview(quickLook) }
        }
        quickLook?.frame = bounds
        quickLook?.isHidden = false
        if quickLook?.previewItem?.previewItemURL != url {
            quickLook?.previewItem = url as NSURL
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let previewKeyMonitor { NSEvent.removeMonitor(previewKeyMonitor) }
        quickLook?.close()
    }

    // MARK: 显示与隐藏

    /// 前台应用（Orca）最前面那个普通窗口的位置，换算成 Cocoa 坐标。
    func frontWindowFrame() -> NSRect? {
        guard let front = NSWorkspace.shared.frontmostApplication,
            let list = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]],
            let primary = NSScreen.screens.first
        else { return nil }
        for info in list {
            guard (info[kCGWindowOwnerPID as String] as? pid_t) == front.processIdentifier,
                (info[kCGWindowLayer as String] as? Int) == 0,
                let dict = info[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary),
                bounds.width > 400, bounds.height > 300
            else { continue }
            return NSRect(
                x: bounds.minX, y: primary.frame.height - bounds.maxY,
                width: bounds.width, height: bounds.height)
        }
        return nil
    }

    func targetFrame() -> NSRect {
        let mouse = NSEvent.mouseLocation
        let fallbackScreen =
            NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
            ?? NSScreen.screens[0]
        let ref = frontWindowFrame() ?? fallbackScreen.visibleFrame
        let center = NSPoint(x: ref.midX, y: ref.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? fallbackScreen
        let visible = screen.visibleFrame
        let width = min(max(ref.width * 0.74, 900), 1280, visible.width - 40)
        let height = min(max(ref.height * 0.70, 500), 780, visible.height - 40)
        var x = ref.midX - width / 2
        var y = ref.midY - height / 2 + ref.height * 0.03
        x = min(max(x, visible.minX + 20), visible.maxX - width - 20)
        y = min(max(y, visible.minY + 20), visible.maxY - height - 20)
        return NSRect(x: x, y: y, width: width, height: height).integral
    }

    func show() {
        if !panel.isVisible { panel.setFrame(targetFrame(), display: true) }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(web)
        web.evaluateJavaScript("window.__focus && window.__focus()", completionHandler: nil)
    }

    func hide() {
        guard panel.isVisible else { return }
        quickLook?.previewItem = nil
        quickLook?.isHidden = true
        panel.orderOut(nil)
        web.evaluateJavaScript("window.__hide && window.__hide()", completionHandler: nil)
        emit("{\"type\":\"hidden\"}")
    }

    func windowDidResignKey(_ notification: Notification) {
        if snapshotPath == nil { hide() }
    }

    // MARK: 自测截图（不读 stdin，不上屏）

    func runSnapshot(to path: String) {
        if let size = argValue("--size")?.split(separator: "x"), size.count == 2,
            let w = Double(size[0]), let h = Double(size[1])
        {
            panel.setFrame(NSRect(x: -4000, y: -4000, width: w, height: h), display: true)
        } else {
            panel.setFrameOrigin(NSPoint(x: -4000, y: -4000))
        }
        panel.orderFrontRegardless()
        if let feedPath, let feed = try? String(contentsOfFile: feedPath, encoding: .utf8) {
            // 逐行间隔投递，给页面留出发起预览请求等异步步骤的时间。
            let lines = feed.split(separator: "\n").filter { !$0.isEmpty }
            for (i, line) in lines.enumerated() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15 * Double(i)) {
                    self.deliver(String(line), then: nil)
                }
            }
            snapshotAfter(delay + 0.15 * Double(lines.count), path)
            return
        }
        snapshotAfter(delay, path)
    }

    func snapshotAfter(_ delay: Double, _ path: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.capture(to: path) { NSApp.terminate(nil) }
        }
    }

    /// 把页面当前画面存成 PNG（自测用）。
    func capture(to path: String, then: @escaping () -> Void) {
        web.takeSnapshot(with: nil) { image, _ in
            if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:])
            {
                try? png.write(to: URL(fileURLWithPath: path))
            }
            then()
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
