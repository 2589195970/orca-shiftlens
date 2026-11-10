import { assert, test } from 'orca/testing'
import { isBoundary, matchName, rank, toEntry } from './fuzzy'

const names = (query: string, files: string[]): string[] =>
  rank(files.map(toEntry), query, 50).map((r) => r.entry.name)

test('子串匹配：完全同名排最前，其次是开头命中', () => {
  const files = [
    'a/OrderUserServiceTest.java',
    'a/UserServiceImpl.java',
    'a/UserService.java',
    'a/README.md'
  ]
  assert.deepEqual(names('userservice', files), [
    'UserService.java',
    'UserServiceImpl.java',
    'OrderUserServiceTest.java'
  ])
})

test('驼峰首字母匹配，并给出高亮位置', () => {
  const m = matchName('UserService.java', 'userservice.java', 'us')
  assert.deepEqual(m?.hits, [0, 1])
  assert.deepEqual(matchName('UserService.java', 'userservice.java', 'usse')?.hits, [0, 1, 4, 5])
  assert.deepEqual(matchName('user_order-detail.vue', 'user_order-detail.vue', 'uod')?.hits, [0, 5, 11])
})

test('不做任意子序列匹配', () => {
  assert.equal(matchName('MultiSelectHeader.vue', 'multiselectheader.vue', 'user'), null)
  assert.deepEqual(names('user', ['x/MultiSelectHeader.vue']), [])
})

test('多个词都要命中；带 / 的词按路径匹配', () => {
  const files = ['web/src/views/user/index.vue', 'web/src/views/order/index.vue', 'api/index.ts']
  assert.deepEqual(names('user/ index', files), ['index.vue'])
  assert.deepEqual(names('index vue', files), ['index.vue', 'index.vue'])
  assert.deepEqual(names('   ', files), [])
})

test('词边界', () => {
  assert.equal(isBoundary('XMLParser', 3), true)
  assert.equal(isBoundary('XMLParser', 1), false)
  assert.equal(isBoundary('file2name', 4), true)
  assert.equal(isBoundary('a.b', 2), true)
})
