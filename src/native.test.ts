import { assert, test } from 'orca/testing'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareNative } from './native'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'shiftlens-native-'))
  const plugin = path.join(root, 'plugin')
  const cache = path.join(root, 'cache')
  await mkdir(path.join(plugin, 'native'), { recursive: true })
  await writeFile(path.join(plugin, 'native', 'main.swift'), '// source version 1\n')
  const calls: string[] = []
  const run = async (file: string, args: string[]): Promise<void> => {
    calls.push(path.basename(file))
    if (file.endsWith('/xcrun')) {
      const output = args[args.indexOf('-o') + 1]
      await writeFile(output, 'compiled locally')
      await chmod(output, 0o700)
    }
  }
  return { root, plugin, cache, calls, run }
}

test('首次使用在缓存构建，后续打开复用生成物；插件源码目录保持不变', async () => {
  const f = await fixture()
  try {
    const options = { cacheRoot: f.cache, run: f.run }
    assert.equal(await prepareNative(f.plugin, { ...options, build: false }), null)
    assert.equal(f.calls.length, 0)
    const binary = await prepareNative(f.plugin, options)
    assert.ok(binary?.startsWith(f.cache + path.sep))
    assert.equal(await readFile(binary!, 'utf8'), 'compiled locally')
    assert.deepEqual(f.calls, ['xcode-select', 'xcrun', 'codesign'])
    assert.equal(await prepareNative(f.plugin, options), binary)
    assert.equal(f.calls.length, 3)
    assert.deepEqual(await readdir(f.plugin), ['native'])
    assert.deepEqual(await readdir(path.dirname(binary!)), ['search-panel'])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Swift 源码改变后构建新的缓存版本', async () => {
  const f = await fixture()
  try {
    const options = { cacheRoot: f.cache, run: f.run }
    const first = await prepareNative(f.plugin, options)
    await writeFile(path.join(f.plugin, 'native', 'main.swift'), '// source version 2\n')
    const second = await prepareNative(f.plugin, options)
    assert.ok(first !== second)
    assert.equal(f.calls.length, 6)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('缺少开发工具时提供明确的安装指令', async () => {
  const f = await fixture()
  try {
    let message = ''
    try {
      await prepareNative(f.plugin, { cacheRoot: f.cache, run: async () => { throw new Error('missing tools') } })
    } catch (error) { message = String(error) }
    assert.ok(message.includes('xcode-select --install'))
    assert.deepEqual(await readdir(f.plugin), ['native'])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('编译失败清理临时文件，重试可以成功', async () => {
  const f = await fixture()
  try {
    let failed = false
    try {
      await prepareNative(f.plugin, {
        cacheRoot: f.cache,
        run: async (file, args) => {
          await f.run(file, args)
          if (file.endsWith('/xcrun')) throw new Error('compile failed')
        }
      })
    } catch { failed = true }
    assert.equal(failed, true)
    const directories = await readdir(f.cache)
    assert.deepEqual(await readdir(path.join(f.cache, directories[0])), [])
    assert.ok(await prepareNative(f.plugin, { cacheRoot: f.cache, run: f.run }))
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('停用插件时中止构建，不产生可执行缓存', async () => {
  const f = await fixture()
  const controller = new AbortController()
  try {
    let failed = false
    try {
      await prepareNative(f.plugin, {
        cacheRoot: f.cache,
        signal: controller.signal,
        run: async (file, args) => {
          await f.run(file, args)
          if (file.endsWith('/xcrun')) controller.abort()
        }
      })
    } catch { failed = true }
    assert.equal(failed, true)
    const directories = await readdir(f.cache)
    assert.deepEqual(await readdir(path.join(f.cache, directories[0])), [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
