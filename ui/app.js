// 悬浮窗界面：把输入发给 worker，把 worker 推来的结果画成「文件 + 命中行」列表和右侧预览。
const $ = (id) => document.getElementById(id)
const q = $('q')
const mask = $('mask')
const list = $('list')
const phead = $('phead')
const pbody = $('pbody')
const progress = $('progress')

const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge
const post = (message) => bridge && bridge.postMessage(JSON.stringify(message))

const opts = { case: false, word: false, regex: false, ignored: false }
let sid = 0
let shownSid = -1 // 列表里当前画的是哪一次查询的结果
let files = new Map() // path -> { item, el }
let selKey = null
let rowsCache = null
let note = null
let pid = 0
let shown = { path: null, start: 0, end: 0 }
let previewTimer = 0
let nativePreview = null

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function setBusy(busy) {
  progress.classList.toggle('busy', busy)
}

// ---------- 查询 ----------

function sendQuery() {
  sid++
  resetList()
  clearPreview()
  shownSid = -1
  setBusy(q.value.length > 0)
  post({ type: 'query', sid, text: q.value, opts: { ...opts, mask: mask.value } })
}

function syncToggles() {
  for (const button of document.querySelectorAll('[data-opt]')) {
    button.classList.toggle('on', opts[button.dataset.opt])
  }
}

function toggle(name) {
  opts[name] = !opts[name]
  syncToggles()
  sendQuery()
}

// ---------- 列表 ----------

function nameHtml(name, hits) {
  if (!hits || !hits.length) return esc(name)
  const on = new Set(hits)
  let html = ''
  for (let i = 0; i < name.length; i++) {
    const ch = esc(name[i])
    html += on.has(i) ? `<b>${ch}</b>` : ch
  }
  return html
}

function markedHtml(text, hits) {
  let html = ''
  let at = 0
  for (const [s, e] of hits || []) {
    if (s < at) continue
    html += esc(text.slice(at, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>'
    at = e
  }
  return html + esc(text.slice(at))
}

function fileHtml(item) {
  const lines = item.lines || []
  const count = lines.length ? `<span class="count">${lines.length}${item.more ? '+' : ''}</span>` : ''
  let html =
    `<div class="row frow" data-key="${esc(item.path)}">` +
    `<span class="fname">${nameHtml(item.name, item.nameHits)}</span>` +
    `<span class="fdir">&lrm;${esc(item.dir)}</span>${count}</div>`
  for (const line of lines) {
    html +=
      `<div class="row lrow" data-key="${esc(item.path)}:${line.n}">` +
      `<span class="ln">${line.n}</span>` +
      `<span class="lt">${markedHtml(line.text, line.hits)}</span></div>`
  }
  return html
}

function resetList() {
  list.textContent = ''
  list.scrollTop = 0
  files = new Map()
  rowsCache = null
  note = null
  selKey = null
}

function upsert(item) {
  const known = files.get(item.path)
  if (known) {
    Object.assign(known.item, item)
    known.el.innerHTML = fileHtml(known.item)
  } else {
    const el = document.createElement('div')
    el.className = 'file'
    el.innerHTML = fileHtml(item)
    list.insertBefore(el, note)
    files.set(item.path, { item, el })
  }
  rowsCache = null
}

function setNote(text, error) {
  if (!text) {
    if (note) note.remove()
    note = null
    return
  }
  if (!note) {
    note = document.createElement('div')
    list.appendChild(note)
  }
  note.className = error ? 'note error' : 'note'
  note.textContent = text
}

const rows = () => rowsCache || (rowsCache = [...list.querySelectorAll('.row')])

function rowOf(key) {
  return key == null ? null : rows().find((row) => row.dataset.key === key) || null
}

function select(key, scroll) {
  const previous = list.querySelector('.row.sel')
  if (previous) previous.classList.remove('sel')
  const row = rowOf(key)
  selKey = row ? key : null
  if (!row) return clearPreview()
  row.classList.add('sel')
  if (scroll) row.scrollIntoView({ block: 'nearest' })
  requestPreview()
}

/** 结果变化后保持原选中项；没有选中项时落到第一行。 */
function keepSelection() {
  const all = rows()
  if (!all.length) return select(null)
  const row = rowOf(selKey)
  if (row) row.classList.add('sel')
  else select(all[0].dataset.key, false)
}

function move(delta) {
  const all = rows()
  if (!all.length) return
  const at = all.findIndex((row) => row.dataset.key === selKey)
  const next = Math.min(Math.max((at < 0 ? 0 : at) + delta, 0), all.length - 1)
  select(all[next].dataset.key, true)
}

/** 选中项对应的文件与行；选中文件项时，只有正文命中的文件落到第一处命中。 */
function target() {
  const row = rowOf(selKey)
  if (!row) return null
  const key = row.dataset.key
  if (row.classList.contains('lrow')) {
    const cut = key.lastIndexOf(':')
    const path = key.slice(0, cut)
    const n = Number(key.slice(cut + 1))
    const line = files.get(path).item.lines.find((l) => l.n === n)
    return { path, line: n, col: line ? line.col : 1 }
  }
  const item = files.get(key).item
  const first = !item.nameHits && item.lines && item.lines[0]
  return first ? { path: key, line: first.n, col: first.col } : { path: key, line: 0, col: 0 }
}

function openSelected() {
  const t = target()
  if (t) post({ type: 'open', path: t.path, line: t.line, col: t.col })
}

// ---------- 预览 ----------

function clearPreview() {
  clearTimeout(previewTimer)
  hideNativePreview()
  pid++
  shown = { path: null, start: 0, end: 0 }
  phead.textContent = ''
  pbody.textContent = ''
}

function focusLine(line) {
  const old = pbody.querySelector('.pl.target')
  if (old) old.classList.remove('target')
  if (!line) {
    pbody.scrollTop = 0
    return
  }
  const el = pbody.querySelector(`.pl[data-n="${line}"]`)
  if (!el) return
  el.classList.add('target')
  pbody.scrollTop = el.offsetTop - pbody.clientHeight / 2 + el.offsetHeight / 2
  pbody.scrollLeft = 0
}

function requestPreview() {
  const t = target()
  if (!t) return clearPreview()
  clearTimeout(previewTimer)
  // 选中项一变就拒收旧预览，包含这 30ms 防抖期间到达的回复。
  const requestId = ++pid
  const loaded = t.line ? t.line >= shown.start && t.line <= shown.end : shown.start === 1
  if (t.path === shown.path && loaded) {
    return focusLine(t.line)
  }
  hideNativePreview()
  previewTimer = setTimeout(() => {
    post({ type: 'preview', pid: requestId, path: t.path, line: t.line })
  }, 30)
}

function lineHtml(text, tokens, marks) {
  if (!tokens.length && !marks) return esc(text)
  const cls = new Array(text.length).fill('')
  for (const t of tokens) cls.fill('t-' + t.c, t.s, t.e)
  const hit = new Array(text.length).fill(false)
  for (const [s, e] of marks || []) hit.fill(true, s, e)
  let html = ''
  let i = 0
  while (i < text.length) {
    let j = i + 1
    while (j < text.length && cls[j] === cls[i] && hit[j] === hit[i]) j++
    let part = esc(text.slice(i, j))
    if (cls[i]) part = `<span class="${cls[i]}">${part}</span>`
    html += hit[i] ? `<mark>${part}</mark>` : part
    i = j
  }
  return html
}

function hideNativePreview() {
  if (nativePreview) post({ type: 'quicklook', visible: false })
  nativePreview = null
}

function syncNativePreview() {
  if (!nativePreview) return
  const { x, y, width, height } = pbody.getBoundingClientRect()
  post({ type: 'quicklook', visible: true, url: nativePreview, frame: { x, y, width, height } })
}

const UNAVAILABLE = { missing: '文件不存在或不可读取' }

function renderPreview(m) {
  hideNativePreview()
  phead.textContent = '‎' + m.path
  if (m.kind === 'quicklook') {
    pbody.textContent = ''
    shown = { path: m.path, start: 1, end: 0 }
    nativePreview = m.url
    syncNativePreview()
    return
  }
  if (m.unavailable) {
    shown = { path: null, start: 0, end: 0 }
    pbody.innerHTML = `<div class="note">${UNAVAILABLE[m.unavailable] || ''}</div>`
    return
  }
  const lang = Highlight.langOf(m.path)
  const state = { block: '' }
  let html = ''
  m.lines.forEach((text, i) => {
    const n = m.start + i
    const tokens = Highlight.tokenize(text, lang, state)
    html +=
      `<div class="pl" data-n="${n}"><span class="pn">${n}</span>` +
      `<span class="pc">${lineHtml(text, tokens, m.marks && m.marks[n])}</span></div>`
  })
  pbody.innerHTML = html
  shown = { path: m.path, start: m.start, end: m.start + m.lines.length - 1 }
  focusLine(m.line)
}

// ---------- 来自 worker 的消息 ----------

const handlers = {
  show(m) {
    q.placeholder = `在 ${m.name} 中搜索`
    Object.assign(opts, { case: false, word: false, regex: false, ignored: false }, m.opts)
    mask.value = (m.opts && m.opts.mask) || ''
    delete opts.mask
    syncToggles()
    q.value = m.query || ''
    resetList()
    clearPreview()
    shownSid = -1
    sendQuery()
  },
  files(m) {
    if (m.sid !== sid) return
    resetList()
    shownSid = m.sid
    for (const item of m.items) upsert(item)
    keepSelection()
  },
  hits(m) {
    if (m.sid !== sid || m.sid !== shownSid) return
    const selectedPath = target()?.path
    for (const item of m.items) upsert(item)
    keepSelection()
    // 正文结果晚于文件名结果到达；让已显示的预览取得新的高亮。
    if (!nativePreview && m.items.some((item) => item.path === selectedPath)) {
      shown = { path: null, start: 0, end: 0 }
      requestPreview()
    }
  },
  done(m) {
    if (m.sid !== sid) return
    setBusy(false)
    if (m.error) setNote(m.error, true)
    else if (m.truncated) setNote(`结果过多，仅显示前 ${m.limit} 个文件`)
    else if (!files.size && q.value) setNote('无匹配结果')
    else setNote('')
  },
  preview(m) {
    if (m.pid === pid) renderPreview(m)
  }
}

window.__recv = (m) => handlers[m.type] && handlers[m.type](m)
window.__focus = () => {
  q.focus()
  q.select()
}
window.__hide = clearPreview
window.addEventListener('resize', syncNativePreview)

// ---------- 输入 ----------

for (const input of [q, mask]) {
  input.addEventListener('input', (e) => { if (!e.isComposing) sendQuery() })
  input.addEventListener('compositionend', sendQuery)
}

document.addEventListener(
  'keydown',
  (e) => {
    // 输入法组字期间的按键留给输入法。
    if (e.isComposing || e.keyCode === 229) return
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const name = { KeyC: 'case', KeyW: 'word', KeyX: 'regex' }[e.code]
      if (name) {
        e.preventDefault()
        toggle(name)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'PageDown':
        move(12)
        break
      case 'PageUp':
        move(-12)
        break
      case 'Enter':
        openSelected()
        break
      case 'Escape':
        post({ type: 'hide' })
        break
      default:
        return
    }
    e.preventDefault()
  },
  true
)

for (const button of document.querySelectorAll('[data-opt]')) {
  button.addEventListener('mousedown', (e) => e.preventDefault())
  button.addEventListener('click', () => toggle(button.dataset.opt))
}

// 点击结果只选中，焦点留在输入框；双击打开。
list.addEventListener('mousedown', (e) => {
  e.preventDefault()
  const row = e.target.closest('.row')
  if (row) select(row.dataset.key, false)
})
list.addEventListener('dblclick', (e) => {
  if (e.target.closest('.row')) openSelected()
})
