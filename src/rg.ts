// ripgrep 的参数拼装与 --json 输出解析。
import { Buffer } from 'node:buffer'

export type SearchOptions = {
  case: boolean
  word: boolean
  regex: boolean
  ignored: boolean
  mask: string
}

export const LINES_PER_FILE = 30

/** 依赖、构建产物、日志和压缩包：默认不搜，「包含忽略文件」打开后才搜。 */
export const EXCLUDED = [
  '.git',
  'node_modules',
  'target',
  'dist',
  '.idea',
  '.gradle',
  'logs',
  'coverage',
  '__pycache__',
  '.venv',
  '.next',
  '.nuxt',
  '.DS_Store',
  '*.log',
  '*.class',
  '*.jar',
  '*.war',
  '*.ear',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.tgz',
  '*.7z',
  '*.rar',
  '*.min.js',
  '*.min.css',
  '*.map'
]

/** 锁文件、办公文档与媒体只参与文件名搜索。 */
const CONTENT_EXCLUDED = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '*.{pdf,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,rtf,pages,numbers,key}',
  '*.{png,jpg,jpeg,gif,webp,ico,icns,bmp,tif,tiff,heic,heif,avif,psd,svgz}',
  '*.{mp3,mp4,m4a,m4v,mov,wav,aiff,ogg,webm,woff,woff2,ttf,otf}',
  '*.{class,jar,war,ear,zip,tar,gz,tgz,7z,rar}'
]

/** `java, .vue *.xml !*.test.js` -> ripgrep 的 glob 列表。 */
export function maskGlobs(mask: string): string[] {
  return mask
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((token) => {
      const negative = token.startsWith('!')
      let body = negative ? token.slice(1) : token
      if (/^[\w-]+$/.test(body)) body = '*.' + body
      else if (/^\.[\w.-]+$/.test(body)) body = '*' + body
      return (negative ? '!' : '') + body
    })
    .filter((glob) => glob !== '!' && glob !== '')
}

function scopeArgs(opts: SearchOptions): string[] {
  const args = ['--hidden', '--no-require-git', '--no-messages']
  for (const glob of maskGlobs(opts.mask)) args.push('-g', glob)
  // 后出现的 glob 优先，所以排除项放在文件类型之后。
  if (opts.ignored) args.push('--no-ignore', '-g', '!.git')
  else for (const glob of EXCLUDED) args.push('-g', '!' + glob)
  return args
}

export function fileArgs(opts: SearchOptions): string[] {
  return ['--files', ...scopeArgs(opts), './']
}

export function contentArgs(text: string, opts: SearchOptions): string[] {
  const args = ['--json', ...scopeArgs(opts)]
  for (const glob of CONTENT_EXCLUDED) args.push('--iglob', '!' + glob)
  args.push('--max-count', String(LINES_PER_FILE), '--max-filesize', '2M')
  if (!opts.regex) args.push('-F')
  args.push(opts.case ? '-s' : '-i')
  if (opts.word) args.push('-w')
  args.push('-e', text, './')
  return args
}

export const cleanPath = (p: string): string => (p.startsWith('./') ? p.slice(2) : p)

type RgText = { text?: string; bytes?: string }

export function decode(field: RgText | undefined): string {
  if (!field) return ''
  if (typeof field.text === 'string') return field.text
  return field.bytes ? Buffer.from(field.bytes, 'base64').toString('utf8') : ''
}

/** 一处命中行：text 去掉了行尾换行，hits 是字符下标（ripgrep 给的是字节偏移）。 */
export type RawLine = { n: number; text: string; hits: [number, number][] }

export function parseMatch(data: {
  lines?: RgText
  line_number?: number
  submatches?: { start: number; end: number }[]
}): RawLine {
  const lines = data.lines ?? {}
  const bytes =
    typeof lines.text === 'string'
      ? Buffer.from(lines.text, 'utf8')
      : Buffer.from(lines.bytes ?? '', 'base64')
  const full = bytes.toString('utf8')
  const text = full.replace(/\r?\n$/, '')
  const ascii = bytes.length === full.length
  const at = (offset: number): number =>
    Math.min(ascii ? offset : bytes.toString('utf8', 0, offset).length, text.length)
  const hits: [number, number][] = []
  for (const sub of (data.submatches ?? []).slice(0, 50)) {
    const s = at(sub.start)
    const e = at(sub.end)
    if (e > s) hits.push([s, e])
  }
  return { n: data.line_number ?? 0, text, hits }
}

export type DisplayLine = { n: number; col: number; text: string; hits: [number, number][] }

/** 列表里的一行：去掉缩进；首个命中离行首太远时从它前面一点开始，保证命中看得见。 */
export function displayLine(raw: RawLine, max = 220): DisplayLine {
  const first = raw.hits[0]?.[0] ?? 0
  let start = raw.text.length - raw.text.trimStart().length
  let prefix = ''
  if (first - start > 32) {
    start = first - 20
    prefix = '…'
  }
  const text = prefix + raw.text.slice(start, start + max)
  const shift = prefix.length - start
  const hits: [number, number][] = []
  for (const [s, e] of raw.hits) {
    const a = Math.max(s + shift, prefix.length)
    const b = Math.min(e + shift, text.length)
    if (b > a) hits.push([a, b])
  }
  return { n: raw.n, col: first + 1, text, hits }
}
