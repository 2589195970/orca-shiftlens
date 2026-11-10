// 从随插件发布的 Swift 源码构建悬浮窗；生成物保存在用户缓存中。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

type Run = (file: string, args: string[], signal?: AbortSignal) => Promise<void>
type Options = {
  cacheRoot?: string
  build?: boolean
  signal?: AbortSignal
  onBuild?: () => void
  run?: Run
}

const run: Run = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 120_000, maxBuffer: 1024 * 1024, signal }, (error) => {
    if (error) reject(error)
    else resolve()
  })
})

/** 首次使用需要 Xcode Command Line Tools；同一份源码只需编译一次。 */
export async function prepareNative(pluginRoot: string, options: Options = {}): Promise<string | null> {
  const source = path.join(pluginRoot, 'native', 'main.swift')
  const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 24)
  const cacheRoot = options.cacheRoot ?? path.join(homedir(), 'Library', 'Caches', 'ShiftLens', 'native')
  const directory = path.join(cacheRoot, `${process.platform}-${process.arch}-${hash}`)
  const binary = path.join(directory, 'search-panel')
  options.signal?.throwIfAborted()
  try {
    await access(binary, constants.X_OK)
    return binary
  } catch {
    if (options.build === false) return null
  }

  const execute = options.run ?? run
  try {
    await execute('/usr/bin/xcode-select', ['-p'], options.signal)
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new Error('需要 Xcode Command Line Tools，请在终端运行 xcode-select --install 后重试', { cause: error })
  }
  options.onBuild?.()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(path.join(directory, 'build-'))
  try {
    const output = path.join(temporary, 'search-panel')
    await execute('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', source, '-o', output], options.signal)
    options.signal?.throwIfAborted()
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', output], options.signal)
    options.signal?.throwIfAborted()
    await rename(output, binary)
    return binary
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
