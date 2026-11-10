// 在可控的 DOM 与计时器上运行实际界面脚本，验证异步结果交错时的行为。
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

class Element {
  value = ''
  dataset: Record<string, string> = {}
  children: Element[] = []
  parent: Element | null = null
  scrollTop = 0
  private html = ''
  private text = ''
  private classes = new Set<string>()
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name)
  }
  set className(value: string) { this.classes = new Set(value.split(' ')) }
  set textContent(value: string) { this.text = value; this.html = ''; this.children = [] }
  get textContent(): string { return this.text }
  set innerHTML(value: string) {
    this.html = value
    this.children = []
    for (const match of value.matchAll(/<div class="(row [^"]+)" data-key="([^"]*)">/g)) {
      const row = new Element()
      row.className = match[1]
      row.dataset.key = match[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      this.appendChild(row)
    }
  }
  get innerHTML(): string { return this.html }
  appendChild(child: Element): void { this.insertBefore(child, null) }
  insertBefore(child: Element, before: Element | null): void {
    child.parent = this
    const at = before ? this.children.indexOf(before) : -1
    if (at < 0) this.children.push(child)
    else this.children.splice(at, 0, child)
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
  }
  querySelectorAll(selector: string): Element[] {
    const required = selector.split('.').filter(Boolean)
    return this.children.flatMap((child) => [
      ...(required.every((name) => child.classList.contains(name)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ])
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  addEventListener(): void {}
  scrollIntoView(): void {}
  focus(): void {}
  select(): void {}
  getBoundingClientRect() { return { x: 440, y: 77, width: 600, height: 563 } }
}

function page() {
  const elements = new Map<string, Element>()
  const element = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  const messages: Record<string, any>[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const context = createContext({
    document: {
      getElementById: element,
      createElement: () => new Element(),
      querySelectorAll: () => [],
      addEventListener: () => undefined
    },
    window: { addEventListener: () => undefined, webkit: { messageHandlers: { bridge: { postMessage: (text: string) => messages.push(JSON.parse(text)) } } } },
    Highlight: { langOf: () => '', tokenize: () => [] },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId },
    clearTimeout: (id: number) => timers.delete(id)
  })
  runInContext(readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8'), context)
  const recv = (message: Record<string, unknown>): void => {
    context.message = message
    runInContext('window.__recv(message)', context)
  }
  return {
    element, messages, recv,
    run: (code: string): void => { runInContext(code, context) },
    flush: (): void => {
      const queued = [...timers.values()]
      timers.clear()
      for (const fn of queued) fn()
    }
  }
}

const file = (path: string) => ({ path, name: path, dir: '', nameHits: [0] })
const preview = (pid: number, path: string, text: string, marks = {}) => ({
  type: 'preview', pid, path, line: 0, start: 1, lines: [text], marks
})

test('选中项改变后，防抖期间到达的旧预览无法覆盖新选择', () => {
  const p = page()
  p.recv({ type: 'show', name: 'project', query: 'java' })
  p.recv({ type: 'files', sid: 1, items: [file('A.java'), file('B.java')] })
  p.flush()
  const first = p.messages.at(-1)!
  p.run("select('B.java', false)")
  p.recv(preview(first.pid, 'A.java', 'stale'))
  assert.equal(p.element('pbody').innerHTML, '')
  p.flush()
  const second = p.messages.at(-1)!
  assert.equal(second.path, 'B.java')
  p.recv(preview(second.pid, 'B.java', 'current'))
  assert.ok(p.element('pbody').innerHTML.includes('current'))
})

test('新查询立即清空旧结果、取消预览计时器并拒收旧回复', () => {
  const p = page()
  p.recv({ type: 'show', name: 'project', query: 'A' })
  p.recv({ type: 'files', sid: 1, items: [file('A.java')] })
  p.element('q').value = 'B'
  p.run('sendQuery()')
  p.flush()
  assert.equal(p.element('list').children.length, 0)
  assert.equal(p.messages.filter((m) => m.type === 'preview').length, 0)
  p.recv(preview(2, 'A.java', 'stale'))
  assert.equal(p.element('pbody').innerHTML, '')
  p.recv({ type: 'hits', sid: 1, items: [{ ...file('A.java'), lines: [] }] })
  assert.equal(p.element('list').children.length, 0)
})

test('正文结果到达后，已选中文件的预览刷新高亮', () => {
  const p = page()
  p.recv({ type: 'show', name: 'project', query: 'User' })
  p.recv({ type: 'files', sid: 1, items: [file('User.java')] })
  p.flush()
  p.recv(preview(p.messages.at(-1)!.pid, 'User.java', 'class User {}'))
  assert.ok(!p.element('pbody').innerHTML.includes('<mark>'))
  p.recv({ type: 'hits', sid: 1, items: [{ path: 'User.java', name: 'User.java', dir: '', lines: [{ n: 1, col: 7, text: 'class User {}', hits: [[6, 10]] }] }] })
  p.flush()
  assert.equal(p.messages.filter((m) => m.type === 'preview').length, 2)
  p.recv(preview(p.messages.at(-1)!.pid, 'User.java', 'class User {}', { 1: [[6, 10]] }))
  assert.ok(p.element('pbody').innerHTML.includes('<mark>User</mark>'))
})

test('包含引号和 HTML 字符的文件名可选中并按原路径打开', () => {
  const p = page()
  const name = 'a"<b>&.java'
  p.recv({ type: 'show', name: 'project', query: 'a' })
  p.recv({ type: 'files', sid: 1, items: [file(name)] })
  p.run('openSelected()')
  assert.equal(p.messages.at(-1)!.path, name)
  const html = p.element('list').children[0].innerHTML
  assert.ok(html.includes('&quot;') && html.includes('&lt;b&gt;'))
})

test('原生预览使用右侧区域，并在切换结果或新查询时释放', () => {
  const p = page()
  p.recv({ type: 'show', name: 'project', query: 'image' })
  p.recv({ type: 'files', sid: 1, items: [file('image.png'), file('image.svg')] })
  p.flush()
  const request = p.messages.at(-1)!
  p.recv({ type: 'preview', pid: request.pid, path: 'image.png', line: 0, kind: 'quicklook', url: 'file:///tmp/image.png' })
  const native = p.messages.at(-1)!
  assert.equal(native.type, 'quicklook')
  assert.equal(native.visible, true)
  assert.deepEqual(native.frame, { x: 440, y: 77, width: 600, height: 563 })
  p.run("select('image.svg', false)")
  assert.equal(p.messages.at(-1)!.visible, false)
  p.recv({ type: 'preview', pid: request.pid, path: 'image.png', kind: 'quicklook', url: 'file:///tmp/image.png' })
  assert.equal(p.messages.at(-1)!.visible, false)
  p.flush()
  p.recv({ type: 'preview', pid: p.messages.at(-1)!.pid, path: 'image.svg', line: 0, kind: 'quicklook', url: 'file:///tmp/image.svg' })
  p.run('sendQuery()')
  assert.equal(p.messages.at(-2)!.visible, false)
  assert.equal(p.messages.at(-1)!.type, 'query')
})
