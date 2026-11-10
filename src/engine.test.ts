// 用真实的 ripgrep 在临时目录里跑一遍；机器上找不到 rg 时跳过。
import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine'

function findRg(): string | null {
  const bundled = `/Applications/Orca.app/Contents/Resources/ripgrep/${process.platform}-${process.arch}/rg`
  if (existsSync(bundled)) return bundled
  try {
    execFileSync('rg', ['--version'])
    return 'rg'
  } catch {
    return null
  }
}

const rg = findRg()
const withRg = (name: string, fn: () => Promise<void>): void => {
  if (rg) test(name, fn)
}
const opts = { case: false, word: false, regex: false, ignored: false, mask: '' }
type Message = Record<string, any>

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'search-everywhere-'))
  const write = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  write('api/src/UserService.java', 'package x;\n\npublic class UserService {\n    UserService() {}\n}\n')
  write('api/src/OrderController.java', 'class OrderController {\n  private UserService userService;\n}\n')
  write('web/src/user.vue', '<template>\n  <div>用户 userservice</div>\n</template>\n')
  write('web/node_modules/dep/UserService.js', 'module.exports = "UserService"\n')
  write('api/target/UserService.class', 'UserService\u0000\u0001')
  write('api/app.war', 'UserService')
  write('web/.gitignore', 'generated/\n')
  write('web/generated/out.js', 'UserService\n')
  write('docs/guide.pdf', '%PDF-1.4\u0000UserService')
  write('docs/text.pdf', '%PDF-1.4\nUserService\n')
  return root
}

/** 发一次查询，收集到 done 为止。 */
function search(engine: Engine, inbox: Message[], sid: number, text: string, extra = {}): Promise<Message[]> {
  inbox.length = 0
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(timer)
      reject(new Error(`查询 ${sid} 未完成`))
    }, 5000)
    const timer = setInterval(() => {
      if (!inbox.some((m) => m.type === 'done' && m.sid === sid)) return
      clearInterval(timer)
      clearTimeout(deadline)
      resolve([...inbox])
    }, 10)
    void engine.query({ sid, text, opts: { ...opts, ...extra } })
  })
}

const hitPaths = (messages: Message[]): string[] =>
  messages
    .filter((m) => m.type === 'hits')
    .flatMap((m) => m.items.map((i: Message) => i.path))
    .sort()

withRg('文件名与正文混合，默认排除依赖、构建产物和 .gitignore 里的目录', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine(rg!, (m) => inbox.push(m))
  try {
    engine.setRoot(root)
    const messages = await search(engine, inbox, 1, 'UserService')
    const files = messages.find((m) => m.type === 'files')!
    assert.deepEqual(
      files.items.map((i: Message) => i.path),
      ['api/src/UserService.java']
    )
    assert.deepEqual(hitPaths(messages), [
      'api/src/OrderController.java',
      'api/src/UserService.java',
      'web/src/user.vue'
    ])
    const own = messages
      .filter((m) => m.type === 'hits')
      .flatMap((m) => m.items)
      .find((i: Message) => i.path === 'api/src/UserService.java')
    assert.deepEqual(
      own.lines.map((l: Message) => [l.n, l.col, l.text]),
      [
        [3, 14, 'public class UserService {'],
        [4, 5, 'UserService() {}']
      ]
    )
    assert.equal(messages.at(-1)!.error, undefined)
  } finally {
    engine.cancel()
    rmSync(root, { recursive: true, force: true })
  }
})

withRg('开关：大小写、文件类型、包含忽略文件、正则错误', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine(rg!, (m) => inbox.push(m))
  try {
    engine.setRoot(root)
    assert.deepEqual(hitPaths(await search(engine, inbox, 1, 'userservice', { case: true })), [
      'web/src/user.vue'
    ])
    assert.deepEqual(hitPaths(await search(engine, inbox, 2, 'UserService', { mask: 'java' })), [
      'api/src/OrderController.java',
      'api/src/UserService.java'
    ])
    const all = await search(engine, inbox, 3, 'UserService', { ignored: true })
    assert.ok(hitPaths(all).includes('web/node_modules/dep/UserService.js'))
    assert.ok(hitPaths(all).includes('web/generated/out.js'))
    assert.ok(!hitPaths(all).includes('docs/text.pdf'))
    const names = all.find((m) => m.type === 'files')!.items.map((i: Message) => i.path)
    assert.ok(names.includes('api/target/UserService.class'))
    const broken = await search(engine, inbox, 4, 'User(', { regex: true })
    assert.equal(broken.at(-1)!.error, '正则表达式无效')
    const pdf = await search(engine, inbox, 5, 'guide')
    assert.deepEqual(
      pdf.find((m) => m.type === 'files')!.items.map((i: Message) => i.path),
      ['docs/guide.pdf']
    )
    assert.deepEqual(hitPaths(pdf), [])
  } finally {
    engine.cancel()
    rmSync(root, { recursive: true, force: true })
  }
})

test('搜索程序不存在时返回可见错误并结束查询', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine(path.join(root, 'missing-rg'), (m) => inbox.push(m))
  try {
    engine.setRoot(root)
    const messages = await search(engine, inbox, 1, 'UserService')
    assert.equal(messages.at(-1)!.type, 'done')
    assert.ok(messages.at(-1)!.error.includes('无法读取文件清单'))
  } finally {
    engine.setRoot('')
    rmSync(root, { recursive: true, force: true })
  }
})

withRg('快速切换工作区时只返回新查询的结果', async () => {
  const root = project()
  const other = project()
  const inbox: Message[] = []
  const engine = new Engine(rg!, (m) => inbox.push(m))
  try {
    engine.setRoot(root)
    const pending = engine.query({ sid: 1, text: 'UserService', opts })
    engine.setRoot(other)
    await search(engine, inbox, 2, 'OrderController')
    await pending
    assert.ok(inbox.every((m) => m.sid === 2))
    assert.deepEqual(inbox.find((m) => m.type === 'files')!.items.map((m: Message) => m.path), ['api/src/OrderController.java'])
  } finally {
    engine.setRoot('')
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

withRg('超长行的预览保留命中和对应高亮', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine(rg!, (m) => inbox.push(m))
  writeFileSync(path.join(root, 'long.txt'), 'a'.repeat(4000) + 'NEEDLE' + 'z'.repeat(4000))
  try {
    engine.setRoot(root)
    await search(engine, inbox, 1, 'NEEDLE')
    inbox.length = 0
    await engine.preview({ pid: 1, path: 'long.txt', line: 1 })
    const [s, e] = inbox[0].marks[1][0]
    assert.equal(inbox[0].lines[0].slice(s, e), 'NEEDLE')
    assert.ok(inbox[0].lines[0].length <= 2001)
  } finally {
    engine.setRoot('')
    rmSync(root, { recursive: true, force: true })
  }
})

withRg('预览：文本高亮、PDF 原生预览和越界路径检查', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine(rg!, (m) => inbox.push(m))
  try {
    engine.setRoot(root)
    await search(engine, inbox, 1, 'UserService')
    inbox.length = 0
    await engine.preview({ pid: 7, path: 'api/src/UserService.java', line: 3 })
    await engine.preview({ pid: 8, path: 'docs/guide.pdf', line: 0 })
    await engine.preview({ pid: 9, path: '../outside.txt', line: 0 })
    assert.equal(inbox[0].start, 1)
    assert.equal(inbox[0].lines[2], 'public class UserService {')
    assert.deepEqual(inbox[0].marks, { 3: [[13, 24]], 4: [[4, 15]] })
    assert.equal(inbox[1].kind, 'quicklook')
    assert.equal(path.basename(fileURLToPath(inbox[1].url)), 'guide.pdf')
    assert.equal(inbox[2].unavailable, 'missing')
  } finally {
    engine.cancel()
    rmSync(root, { recursive: true, force: true })
  }
})

test('图片、文档、大文件和二进制交给原生预览，文件 URL 保留中文及特殊字符', async () => {
  const root = project()
  const inbox: Message[] = []
  const engine = new Engine('unused', (m) => inbox.push(m))
  const files = ['图片 #100%.PNG', 'report.docx', 'large.jpg', 'movie.mp4', 'binary.bin', 'large.txt']
  try {
    engine.setRoot(root)
    for (const name of files) {
      writeFileSync(path.join(root, name), name.startsWith('large') ? Buffer.alloc(3 * 1024 * 1024, 65) : Buffer.from([0, 1, 2]))
      await engine.preview({ pid: inbox.length + 1, path: name, line: 0 })
    }
    assert.equal(inbox.length, files.length)
    for (const [i, message] of inbox.entries()) {
      assert.equal(message.kind, 'quicklook')
      assert.equal(path.basename(fileURLToPath(message.url)), files[i])
      assert.equal(message.lines, undefined)
    }
  } finally {
    engine.setRoot('')
    rmSync(root, { recursive: true, force: true })
  }
})

test('指向工作区外部的符号链接不可交给原生预览', async () => {
  const root = project()
  const outside = mkdtempSync(path.join(tmpdir(), 'preview-outside-'))
  const inbox: Message[] = []
  const engine = new Engine('unused', (m) => inbox.push(m))
  try {
    writeFileSync(path.join(outside, 'image.png'), 'outside')
    symlinkSync(path.join(outside, 'image.png'), path.join(root, 'link.png'))
    engine.setRoot(root)
    await engine.preview({ pid: 1, path: 'link.png', line: 0 })
    assert.equal(inbox[0].unavailable, 'missing')
    assert.equal(inbox[0].url, undefined)
  } finally {
    engine.setRoot('')
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
