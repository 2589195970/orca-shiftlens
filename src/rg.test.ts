import { assert, test } from 'orca/testing'
import { contentArgs, displayLine, fileArgs, maskGlobs, parseMatch } from './rg'

const opts = { case: false, word: false, regex: false, ignored: false, mask: '' }

test('文件类型写法都归一成 glob', () => {
  assert.deepEqual(maskGlobs('java, .vue;*.xml  !*.test.js src/**'), [
    '*.java',
    '*.vue',
    '*.xml',
    '!*.test.js',
    'src/**'
  ])
  assert.deepEqual(maskGlobs(' , '), [])
})

test('默认排除依赖和构建产物，打开开关后只排除 .git', () => {
  const normal = fileArgs(opts)
  assert.ok(normal.includes('!node_modules') && normal.includes('!*.war'))
  assert.ok(!normal.includes('--no-ignore'))
  const all = fileArgs({ ...opts, ignored: true })
  assert.ok(all.includes('--no-ignore') && all.includes('!.git'))
  assert.ok(!all.includes('!node_modules'))
})

test('正文搜索的开关对应到 ripgrep 参数', () => {
  const plain = contentArgs('-x', opts)
  assert.ok(plain.includes('-F') && plain.includes('-i') && !plain.includes('-w'))
  assert.deepEqual(plain.slice(-3), ['-e', '-x', './'])
  const strict = contentArgs('a.b', { ...opts, case: true, word: true, regex: true, mask: 'java' })
  assert.ok(!strict.includes('-F') && strict.includes('-s') && strict.includes('-w'))
  assert.ok(strict.indexOf('*.java') < strict.indexOf('!node_modules'))
})

test('字节偏移换算成字符下标', () => {
  // “用户” 每个字 3 字节，UserService 从第 7 字节开始。
  const line = parseMatch({
    lines: { text: '用户 UserService x\n' },
    line_number: 12,
    submatches: [{ start: 7, end: 18 }]
  })
  assert.deepEqual(line, { n: 12, text: '用户 UserService x', hits: [[3, 14]] })
})

test('非 UTF-8 行按 base64 解码', () => {
  const bytes = Buffer.from('abc UserService\r\n').toString('base64')
  const line = parseMatch({ lines: { bytes }, line_number: 1, submatches: [{ start: 4, end: 15 }] })
  assert.deepEqual(line, { n: 1, text: 'abc UserService', hits: [[4, 15]] })
})

test('列表行去缩进，并记住原始列号', () => {
  const shown = displayLine({ n: 3, text: '    private UserService s;', hits: [[12, 23]] })
  assert.deepEqual(shown, { n: 3, col: 13, text: 'private UserService s;', hits: [[8, 19]] })
})

test('命中离行首较远时从命中前面一点开始显示', () => {
  const text = 'List<SimpleUserVM> simpleUserVMList = SpringUtils.getBean(UserService.class).list();'
  const at = text.indexOf('UserService')
  const shown = displayLine({ n: 226, text, hits: [[at, at + 11]] })
  assert.equal(shown.text.startsWith('…SpringUtils.getBean(UserService'), true)
  assert.equal(shown.text.slice(shown.hits[0][0], shown.hits[0][1]), 'UserService')
  assert.equal(shown.col, at + 1)
})

test('超长行只截取命中附近', () => {
  const text = 'x'.repeat(1000) + 'NEEDLE' + 'y'.repeat(1000)
  const shown = displayLine({ n: 1, text, hits: [[1000, 1006]] })
  assert.equal(shown.text.length, 221)
  assert.equal(shown.col, 1001)
  const [s, e] = shown.hits[0]
  assert.equal(shown.text.slice(s, e), 'NEEDLE')
})
