// 预览用的轻量语法着色：只分注释、字符串、数字、关键字四类，逐行扫描。
// 浏览器里挂到 window，Node 里（测试）走 module.exports。
;(function (root) {
  const KEYWORDS = new Set(
    (
      'abstract as async await boolean break byte case catch char class const continue def default ' +
      'delete do double elif else enum export extends false final finally float for from func ' +
      'function if implements import in instanceof int interface let long new nil none null ' +
      'package private protected public return self short static struct super switch this throw ' +
      'throws true try type typeof undefined var void while yield ' +
      'select insert update set values into where and or not join left right inner outer on ' +
      'group by order having limit create alter drop table index primary key distinct union'
    ).split(' ')
  )

  const C_LIKE = new Set(
    'java js jsx ts tsx mjs cjs c h cc cpp hpp cs go kt kts swift rs php scala groovy gradle json json5 css scss less dart proto'.split(
      ' '
    )
  )
  const HASH = new Set(
    'py sh bash zsh fish yml yaml properties toml rb conf ini cfg env gitignore dockerfile mk pl r'.split(
      ' '
    )
  )
  const MARKUP = new Set('xml html htm vue jsp jspx xsl xslt svg wxml ftl'.split(' '))

  function langOf(path) {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (ext === 'sql') return 'sql'
    if (MARKUP.has(ext)) return 'markup'
    if (C_LIKE.has(ext)) return 'c'
    if (HASH.has(ext) || name.startsWith('.env')) return 'hash'
    return 'plain'
  }

  const IDENT = /[A-Za-z_$][\w$]*/y
  const NUMBER = /\d[\w.]*/y

  /** 返回 [{ s, e, c }]，c 取 'c' | 's' | 'n' | 'k'；state.block 记录跨行的块注释。 */
  function tokenize(line, lang, state) {
    const out = []
    if (lang === 'plain') return out
    const n = line.length
    let i = 0
    const push = (s, e, c) => {
      if (e > s) out.push({ s, e, c })
    }
    const blockEnd = state.block
    if (blockEnd) {
      const end = line.indexOf(blockEnd)
      if (end < 0) {
        push(0, n, 'c')
        return out
      }
      push(0, end + blockEnd.length, 'c')
      i = end + blockEnd.length
      state.block = ''
    }
    const slashComments = lang === 'c' || lang === 'markup'
    while (i < n) {
      const ch = line[i]
      const two = line.substr(i, 2)
      if (slashComments && two === '/*') {
        const end = line.indexOf('*/', i + 2)
        if (end < 0) {
          state.block = '*/'
          push(i, n, 'c')
          return out
        }
        push(i, end + 2, 'c')
        i = end + 2
        continue
      }
      if (lang === 'markup' && line.startsWith('<!--', i)) {
        const end = line.indexOf('-->', i + 4)
        if (end < 0) {
          state.block = '-->'
          push(i, n, 'c')
          return out
        }
        push(i, end + 3, 'c')
        i = end + 3
        continue
      }
      // `//` 前面是冒号时多半是 URL，不当注释。
      if (slashComments && two === '//' && line[i - 1] !== ':') {
        push(i, n, 'c')
        return out
      }
      if (lang === 'hash' && ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        push(i, n, 'c')
        return out
      }
      if (lang === 'sql' && (two === '--' || ch === '#')) {
        push(i, n, 'c')
        return out
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1
        while (j < n && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
        const end = Math.min(j + 1, n)
        push(i, end, 's')
        i = end
        continue
      }
      if (ch >= '0' && ch <= '9') {
        NUMBER.lastIndex = i
        const m = NUMBER.exec(line)
        push(i, i + m[0].length, 'n')
        i += m[0].length
        continue
      }
      IDENT.lastIndex = i
      const id = IDENT.exec(line)
      if (id) {
        const word = lang === 'sql' ? id[0].toLowerCase() : id[0]
        const isTag = lang === 'markup' && (line[i - 1] === '<' || line[i - 1] === '/')
        if (isTag || KEYWORDS.has(word)) push(i, i + id[0].length, 'k')
        i += id[0].length
        continue
      }
      i++
    }
    return out
  }

  const api = { langOf, tokenize }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Highlight = api
})(typeof window === 'undefined' ? globalThis : window)
