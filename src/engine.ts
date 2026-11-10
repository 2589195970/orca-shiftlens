// 搜索引擎：文件名来自缓存的文件清单，正文命中由 ripgrep 流式给出，预览直接读文件。
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { rank, toEntry, type Entry } from './fuzzy'
import {
  LINES_PER_FILE,
  cleanPath,
  contentArgs,
  decode,
  displayLine,
  fileArgs,
  parseMatch,
  type RawLine,
  type SearchOptions
} from './rg'

export const MAX_NAME_MATCHES = 50
export const MAX_CONTENT_FILES = 300
const MIN_CONTENT_CHARS = 2
const CONTENT_DELAY_MS = 120
const INDEX_TTL_MS = 20_000
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
const PREVIEW_RADIUS = 300
const PREVIEW_LINE_CHARS = 2000
const NATIVE_PREVIEW_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.icns',
  '.tif', '.tiff', '.heic', '.heif', '.svg', '.svgz', '.psd',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf',
  '.odt', '.ods', '.odp', '.pages', '.numbers', '.key',
  '.mp3', '.mp4', '.m4a', '.m4v', '.mov', '.wav', '.aiff', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf'
])

export type QueryMessage = { sid: number; text: string; opts: SearchOptions }
export type PreviewMessage = { pid: number; path: string; line: number }
type Send = (message: Record<string, unknown>) => void

const split = (rel: string): { name: string; dir: string } => {
  const slash = rel.lastIndexOf('/')
  return { name: rel.slice(slash + 1), dir: slash < 0 ? '' : rel.slice(0, slash) }
}

export class Engine {
  private root = ''
  private sid = 0
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private indexes = new Map<string, { at: number; entries: Promise<Entry[]> }>()
  private indexChildren = new Set<ChildProcess>()
  private marks = new Map<string, Map<number, [number, number][]>>()

  constructor(
    private readonly rgPath: string,
    private readonly send: Send
  ) {}

  /** 每次打开悬浮窗都调用：切换搜索根目录，并让文件清单重新生成。 */
  setRoot(root: string): void {
    this.cancel()
    for (const child of this.indexChildren) child.kill()
    this.indexChildren.clear()
    this.root = root
    this.indexes.clear()
    this.marks.clear()
  }

  cancel(): void {
    this.sid = -1
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.child?.kill()
    this.child = null
  }

  private index(opts: SearchOptions): Promise<Entry[]> {
    const key = `${opts.ignored}|${opts.mask}`
    const cached = this.indexes.get(key)
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.entries
    const root = this.root
    const entries = new Promise<Entry[]>((resolve, reject) => {
      const child = execFile(
        this.rgPath,
        fileArgs(opts),
        { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
        (error, stdout) => {
          this.indexChildren.delete(child)
          if (error && error.code !== 1) return reject(error)
          // 没有任何文件时 ripgrep 以 1 退出，此时 stdout 为空，按空清单处理。
          const out: Entry[] = []
          for (const line of stdout.split('\n')) if (line) out.push(toEntry(cleanPath(line)))
          resolve(out)
        }
      )
      this.indexChildren.add(child)
    })
    this.indexes.set(key, { at: Date.now(), entries })
    return entries
  }

  async query(m: QueryMessage): Promise<void> {
    this.cancel()
    const sid = (this.sid = m.sid)
    this.marks = new Map()
    if (!this.root || !m.text.trim()) {
      this.send({ type: 'files', sid, items: [] })
      this.send({ type: 'done', sid })
      return
    }
    let entries: Entry[]
    try {
      entries = await this.index(m.opts)
    } catch {
      if (sid === this.sid) {
        this.indexes.delete(`${m.opts.ignored}|${m.opts.mask}`)
        this.send({ type: 'files', sid, items: [] })
        this.send({ type: 'done', sid, error: '无法读取文件清单，请检查搜索程序、工作区或文件类型筛选' })
      }
      return
    }
    if (sid !== this.sid) return
    const items = rank(entries, m.text, MAX_NAME_MATCHES).map((r) => ({
      path: r.entry.rel,
      ...split(r.entry.rel),
      nameHits: r.hits
    }))
    this.send({ type: 'files', sid, items })
    if (m.text.length < MIN_CONTENT_CHARS) {
      this.send({ type: 'done', sid })
      return
    }
    const root = this.root
    this.timer = setTimeout(() => void this.grep(sid, m.text, m.opts, root), CONTENT_DELAY_MS)
  }

  private async grep(sid: number, text: string, opts: SearchOptions, root: string): Promise<void> {
    if (sid !== this.sid) return
    const child = spawn(this.rgPath, contentArgs(text, opts), {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    let failed = false
    let stderr = ''
    child.on('error', () => (failed = true))
    child.stderr.on('data', (data) => {
      if (stderr.length < 8192) stderr += data.toString()
    })

    let current: { path: string; lines: RawLine[] } | null = null
    let batch: Record<string, unknown>[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let fileCount = 0
    let truncated = false
    const flush = (): void => {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      if (batch.length && sid === this.sid) this.send({ type: 'hits', sid, items: batch })
      batch = []
    }

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (sid !== this.sid || truncated) return
      let event: { type: string; data: Record<string, never> }
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'begin') {
        current = { path: cleanPath(decode(event.data.path)), lines: [] }
      } else if (event.type === 'match' && current) {
        current.lines.push(parseMatch(event.data))
      } else if (event.type === 'end' && current) {
        const file = current
        current = null
        if (!file.lines.length) return
        this.marks.set(file.path, new Map(file.lines.map((l) => [l.n, l.hits])))
        batch.push({
          path: file.path,
          ...split(file.path),
          lines: file.lines.map((l) => displayLine(l)),
          more: file.lines.length >= LINES_PER_FILE
        })
        fileCount++
        if (fileCount >= MAX_CONTENT_FILES) {
          truncated = true
          child.kill()
        }
        if (batch.length >= 40) flush()
        else if (!flushTimer) flushTimer = setTimeout(flush, 40)
      }
    })

    const [[code]] = await Promise.all([
      once(child, 'close').catch(() => [2]),
      once(lines, 'close')
    ])
    if (this.child === child) this.child = null
    if (sid !== this.sid) return
    flush()
    const broken = (failed || code === 2) && !fileCount
    this.send({
      type: 'done',
      sid,
      truncated,
      limit: MAX_CONTENT_FILES,
      ...(broken ? { error: !failed && stderr.includes('regex parse error') ? '正则表达式无效' : '搜索失败' } : {})
    })
  }

  async preview(m: PreviewMessage): Promise<void> {
    const root = this.root
    const reply = (extra: Record<string, unknown>): void =>
      this.send({ type: 'preview', pid: m.pid, path: m.path, line: m.line, ...extra })
    let abs = path.resolve(root, m.path)
    const inside = (base: string, file: string): boolean => {
      const rel = path.relative(base, file)
      return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
    }
    if (!root || !inside(root, abs)) return reply({ unavailable: 'missing' })
    const nativePreview = (): void => reply({ kind: 'quicklook', url: pathToFileURL(abs).href })
    let bytes: Buffer
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(abs)])
      if (!inside(realRoot, realFile)) return reply({ unavailable: 'missing' })
      abs = realFile
      const info = await stat(abs)
      if (!info.isFile()) return reply({ unavailable: 'missing' })
      if (NATIVE_PREVIEW_EXTENSIONS.has(path.extname(m.path).toLowerCase()) || info.size > PREVIEW_MAX_BYTES) {
        return nativePreview()
      }
      bytes = await readFile(abs)
    } catch {
      return reply({ unavailable: 'missing' })
    }
    if (bytes.subarray(0, 8192).includes(0)) return nativePreview()
    const all = bytes.toString('utf8').split(/\r?\n/)
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    const start = m.line ? Math.max(1, m.line - PREVIEW_RADIUS) : 1
    const end = Math.min(all.length, (m.line || 1) + PREVIEW_RADIUS)
    const marks: Record<number, [number, number][]> = {}
    for (const [n, hits] of this.marks.get(m.path) ?? []) {
      if (n >= start && n <= end) marks[n] = hits
    }
    const lines = all.slice(start - 1, end).map((line, i) => {
      const n = start + i
      const first = marks[n]?.[0]?.[0] ?? 0
      const offset = first >= PREVIEW_LINE_CHARS - 200 ? first - 200 : 0
      const prefix = offset ? '…' : ''
      const text = prefix + line.slice(offset, offset + PREVIEW_LINE_CHARS)
      if (marks[n]) {
        marks[n] = marks[n]
          .map(([s, e]): [number, number] => [Math.max(prefix.length, s - offset + prefix.length), Math.min(text.length, e - offset + prefix.length)])
          .filter(([s, e]) => e > s)
      }
      return text
    })
    reply({
      start,
      lines,
      marks
    })
  }
}
