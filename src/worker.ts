// 插件入口：响应 ShiftLens 命令，管理悬浮窗进程，把它的消息交给搜索引擎。
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Engine, type PreviewMessage, type QueryMessage } from './engine'
import type { SearchOptions } from './rg'
import { prepareNative } from './native'

type Workspace = { path: string; local: boolean; selector: string }
type Stored = { opts: SearchOptions; queries: Record<string, string> }

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_REMEMBERED_ROOTS = 30

/** Orca.app/Contents/Resources：自带的 ripgrep 和 orca CLI 都在这里。 */
function bundled(...parts: string[]): string | null {
  const marker = '.app/Contents/'
  const at = process.execPath.indexOf(marker)
  if (at < 0) return null
  const file = path.join(process.execPath.slice(0, at + marker.length), 'Resources', ...parts)
  return existsSync(file) ? file : null
}

const RG = bundled('ripgrep', `${process.platform}-${process.arch}`, 'rg') ?? 'rg'
const CLI = bundled('bin', 'orca') ?? 'orca'

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: '/', timeout: 8000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })
}

/** Orca 窗口里当前聚焦的工作区。插件 API 只给名称和分支，路径得从 CLI 取。 */
async function activeWorkspace(): Promise<Workspace | null> {
  const out = JSON.parse(await run(CLI, ['worktree', 'ps', '--json', '--limit', '1000']))
  const rows: {
    isActive?: boolean
    path?: string
    hostId?: string | null
    address?: { worktree?: string; environment?: string } | null
  }[] =
    out?.result?.worktrees ?? []
  const row = rows.find((r) => r.isActive && r.path)
  return row ? {
    path: row.path!,
    local: (!row.hostId || row.hostId === 'local') &&
      (!row.address?.environment || row.address.environment === 'local'),
    selector: row.address?.worktree ?? `path:${row.path}`
  } : null
}

let helper: ChildProcess | null = null
let cleanup: (() => Promise<void>) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  let active: Workspace | null = null
  let stored: Stored = {
    opts: { case: false, word: false, regex: false, ignored: false, mask: '' },
    queries: {}
  }
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let openId = 0
  let helperStarting: Promise<boolean> | null = null
  let prewarmed: Promise<boolean> = Promise.resolve(false)
  const lifetime = new AbortController()

  const loaded = orca.storage
    .get('state')
    .then((value) => {
      const saved = value as Partial<Stored> | null
      if (saved && typeof saved === 'object') {
        stored = { opts: { ...stored.opts, ...saved.opts }, queries: { ...saved.queries } }
      }
    })
    .catch(() => undefined)

  const notify = (body: string): void => {
    orca.host.call('notifications.show', { title: 'ShiftLens · 瞬搜', body }).catch(() => undefined)
  }

  const send = (message: Record<string, unknown>): void => {
    helper?.stdin?.write(JSON.stringify(message) + '\n')
  }
  const engine = new Engine(RG, send)

  function remember(m: QueryMessage): void {
    if (!active) return
    stored.opts = m.opts
    delete stored.queries[active.path]
    stored.queries[active.path] = m.text
    const roots = Object.keys(stored.queries)
    for (const root of roots.slice(0, Math.max(0, roots.length - MAX_REMEMBERED_ROOTS))) {
      delete stored.queries[root]
    }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      orca.storage.set('state', stored).catch(() => undefined)
    }, 400)
  }

  async function openFile(m: { path: string; line: number; col: number }): Promise<void> {
    if (!active) return
    const args = ['file', 'open', path.join(active.path, m.path)]
    if (m.line > 0) args.push('--line', String(m.line), '--column', String(Math.max(1, m.col)))
    args.push('--worktree', active.selector, '--focus', '--json')
    try {
      await run(CLI, args)
    } catch (error) {
      orca.log(`打开失败 ${m.path}: ${String(error)}`)
      notify(`无法打开 ${m.path}`)
    }
  }

  function onMessage(line: string): void {
    let m: { type?: string }
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    switch (m.type) {
      case 'query':
        remember(m as QueryMessage)
        void engine.query(m as QueryMessage)
        break
      case 'preview':
        void engine.preview(m as PreviewMessage)
        break
      case 'open':
        void openFile(m as { path: string; line: number; col: number })
        break
      case 'hidden':
        engine.cancel()
        break
    }
  }

  async function launchHelper(build: boolean): Promise<boolean> {
    const binary = await prepareNative(PLUGIN_ROOT, {
      build,
      signal: lifetime.signal,
      onBuild: () => notify('首次使用正在准备悬浮窗，请稍候…')
    })
    if (!binary || lifetime.signal.aborted) return false
    const child = spawn(binary, ['--ui', path.join(PLUGIN_ROOT, 'ui')], {
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.on('error', (error) => orca.log(`悬浮窗进程出错: ${String(error)}`))
    child.on('close', () => {
      if (helper === child) {
        helper = null
        engine.cancel()
      }
    })
    child.stdin.on('error', () => undefined)
    createInterface({ input: child.stdout }).on('line', onMessage)
    helper = child
    return true
  }

  async function ensureHelper(): Promise<boolean> {
    await prewarmed
    if (lifetime.signal.aborted) return false
    if (helper) return true
    if (!helperStarting) {
      helperStarting = launchHelper(true).catch((error) => {
        if (!lifetime.signal.aborted) {
          orca.log(`准备悬浮窗失败: ${String(error)}`)
          notify(error instanceof Error && error.message.includes('xcode-select --install')
            ? error.message : '无法准备悬浮窗，请检查开发工具并查看插件日志')
        }
        return false
      }).finally(() => { helperStarting = null })
    }
    return helperStarting
  }

  function show(workspace: Workspace): void {
    engine.setRoot(workspace.path)
    send({
      type: 'show',
      name: path.basename(workspace.path),
      query: stored.queries[workspace.path] ?? '',
      opts: stored.opts
    })
  }

  async function openPanel(): Promise<void> {
    const requestId = ++openId
    if (process.platform !== 'darwin') return notify('目前只支持 macOS')
    await loaded
    if (!await ensureHelper() || requestId !== openId || lifetime.signal.aborted) return
    let current: Workspace | null = null
    try {
      current = await activeWorkspace()
    } catch (error) {
      orca.log(`读取当前工作区失败: ${String(error)}`)
    }
    if (requestId !== openId) return
    if (!current || !current.local) {
      active = null
      send({ type: 'hide' })
      return notify(current ? '暂不支持远程工作区' : '没有打开的工作区')
    }
    active = current
    show(current)
  }

  orca.commands.register('open', () => {
    void openPanel()
  })
  // 自测入口：`orca plugin dev request . open --data '{"query":"x","snapshot":"/tmp/a.png"}'`
  // 用指定的搜索词打开，稍后把窗口画面存成 PNG 并关闭。
  orca.panels.handle('open', async (input) => {
    const { query, snapshot, waitMs } = (input ?? {}) as {
      query?: string
      snapshot?: string
      waitMs?: number
    }
    await loaded
    if (typeof query === 'string') {
      const workspace = await activeWorkspace()
      if (workspace) stored.queries[workspace.path] = query
      active = null
    }
    await openPanel()
    if (snapshot) {
      await new Promise((resolve) => setTimeout(resolve, waitMs ?? 1500))
      send({ type: 'snapshot', path: snapshot })
      await new Promise((resolve) => setTimeout(resolve, 400))
      send({ type: 'hide' })
    }
    return { root: active?.path ?? null }
  })

  // 预先拉起悬浮窗进程，双击 Shift 时不必等它启动。
  if (process.platform === 'darwin') {
    prewarmed = launchHelper(false)
      .catch((error) => {
        if (!lifetime.signal.aborted) orca.log(`预加载悬浮窗失败: ${String(error)}`)
        return false
      })
  }
  cleanup = async () => {
    openId++
    lifetime.abort()
    await Promise.allSettled([prewarmed, helperStarting])
    engine.setRoot('')
    helper?.kill()
    helper = null
    if (saveTimer) {
      clearTimeout(saveTimer)
      await orca.storage.set('state', stored).catch(() => undefined)
    }
  }
}

export async function deactivate(): Promise<void> {
  await cleanup?.()
  cleanup = null
}
