// 文件名匹配：先按连续子串，其次按驼峰/分隔符首字母（IDEA 的 "US" -> UserService）。
// 不做任意子序列匹配，那样会带出大量无关文件。

export type Entry = { rel: string; relLower: string; name: string; lower: string }
export type Ranked = { entry: Entry; score: number; hits: number[] }

const SEPARATORS = new Set(['_', '-', '.', ' ', '/'])
const isUpper = (c: string): boolean => c !== c.toLowerCase()
const isLower = (c: string): boolean => c !== c.toUpperCase()
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

export function toEntry(rel: string): Entry {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  return { rel, relLower: rel.toLowerCase(), name, lower: name.toLowerCase() }
}

/** 位置 i 是否是一个「词」的开头：字符串开头、分隔符之后、驼峰大写、数字与字母交界。 */
export function isBoundary(name: string, i: number): boolean {
  if (i === 0) return true
  const prev = name[i - 1]
  const cur = name[i]
  if (SEPARATORS.has(prev)) return true
  if (isUpper(cur)) {
    if (!isUpper(prev)) return true
    const next = name[i + 1]
    return next !== undefined && isLower(next) // XMLParser 里的 P
  }
  return isDigit(cur) !== isDigit(prev) && !SEPARATORS.has(cur)
}

function humps(name: string, lower: string, token: string): number[] | null {
  const dead = new Set<number>()
  const out: number[] = []
  const walk = (qi: number, ni: number, mayContinue: boolean): boolean => {
    if (qi === token.length) return true
    const key = (qi * 4096 + ni) * 2 + (mayContinue ? 1 : 0)
    if (dead.has(key)) return false
    if (mayContinue && lower[ni] === token[qi]) {
      out.push(ni)
      if (walk(qi + 1, ni + 1, true)) return true
      out.pop()
    }
    for (let j = mayContinue ? ni + 1 : ni; j < lower.length; j++) {
      if (lower[j] !== token[qi] || !isBoundary(name, j)) continue
      out.push(j)
      if (walk(qi + 1, j + 1, true)) return true
      out.pop()
    }
    dead.add(key)
    return false
  }
  return walk(0, 0, false) ? out : null
}

/** 单个词对文件名的匹配；token 必须已转小写。 */
export function matchName(name: string, lower: string, token: string): Omit<Ranked, 'entry'> | null {
  let at = -1
  let onBoundary = false
  for (let i = lower.indexOf(token); i >= 0; i = lower.indexOf(token, i + 1)) {
    if (at < 0) at = i
    if (isBoundary(name, i)) {
      at = i
      onBoundary = true
      break
    }
  }
  if (at >= 0) {
    const dot = lower.lastIndexOf('.')
    const stem = dot > 0 ? lower.slice(0, dot) : lower
    let score = 1000 - name.length
    if (at === 0) score += 300
    else if (onBoundary) score += 150
    if (stem === token || lower === token) score += 500
    return { score, hits: Array.from({ length: token.length }, (_, k) => at + k) }
  }
  if (token.length < 2) return null
  const hits = humps(name, lower, token)
  if (!hits) return null
  let gaps = 0
  for (let k = 1; k < hits.length; k++) if (hits[k] !== hits[k - 1] + 1) gaps++
  return { score: 400 - name.length - gaps * 5 + (hits[0] === 0 ? 100 : 0), hits }
}

/** 空格分隔的每个词都要命中；带 `/` 的词按相对路径子串匹配。 */
export function rank(entries: Entry[], query: string, limit: number): Ranked[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const out: Ranked[] = []
  next: for (const entry of entries) {
    let score = 0
    const hits = new Set<number>()
    for (const token of tokens) {
      if (token.includes('/')) {
        if (!entry.relLower.includes(token)) continue next
        score += 600
        continue
      }
      const m = matchName(entry.name, entry.lower, token)
      if (!m) continue next
      score += m.score
      for (const h of m.hits) hits.add(h)
    }
    out.push({ entry, score, hits: [...hits].sort((a, b) => a - b) })
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.rel.length - b.entry.rel.length ||
      (a.entry.rel < b.entry.rel ? -1 : 1)
  )
  return out.slice(0, limit)
}
