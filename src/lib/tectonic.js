/**
 * Managed Tectonic runtime — resolution, verified download, extraction, removal.
 *
 * 这个模块被 `src/index.js` 直接 import（`resolveTectonic` 会塞进 shared），
 * 所以它拿不到 shared，只能自己 import paths / process。
 *
 * 设计约束（AGENTS.md 产品红线 1/2）：
 *   - Tectonic 不打包进 npm 包，首次使用时下载，并用 GitHub Release API 自带的
 *     `digest` 字段校验 sha256。**不硬编码哈希**：硬编码的哈希会在上游重打
 *     release 时静默失效，而 API 的 digest 永远是那一份资产的真实值。
 *   - 这里只装 Tectonic，任何情况下都不碰 TeX Live。
 *
 * 解压只用 Node 内置能力（zlib + 手写 ZIP/TAR 读取器）：
 *   - 加依赖要走 Captain，而 zip 库普遍上百 KB 且引入一棵依赖树；
 *   - 本机虽有 `C:\Windows\system32\tar.exe`，但依赖系统 tar 会在老 Windows 与
 *     精简镜像上直接失败，而那是「第一次用就炸」的路径。
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gunzipSync, inflateRawSync } from 'node:zlib'

import { packageCacheDir, runtimeDir, stagingDir } from './paths.js'
import { isMissingBinary, run } from './process.js'

const RELEASE_API = 'https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest'

/** 托管运行时的可执行文件名跟着平台走；Windows 上少一个 .exe 就 spawn 不到。 */
export const RUNTIME_BINARY = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'

/** 上游资产是按平台的；这张表是唯一的选择依据，别处不许再判断平台。 */
const PLATFORM_TARGETS = {
  'win32/x64': { target: 'x86_64-pc-windows-msvc', ext: 'zip' },
  'darwin/arm64': { target: 'aarch64-apple-darwin', ext: 'tar.gz' },
  'darwin/x64': { target: 'x86_64-apple-darwin', ext: 'tar.gz' },
  'linux/x64': { target: 'x86_64-unknown-linux-gnu', ext: 'tar.gz' },
  'linux/arm64': { target: 'aarch64-unknown-linux-musl', ext: 'tar.gz' },
}

/** 防御一个荒唐的响应；正常资产 10–23MB。 */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

// ---------------------------------------------------------------------------
// 错误：工具层要能区分「校验失败」和「下载失败」，所以错误上带机器可读的 code
// ---------------------------------------------------------------------------

function fail(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

// ---------------------------------------------------------------------------
// 路径与清单
// ---------------------------------------------------------------------------

/** 托管运行时的落点。整块可删，所以 remove 只需要 rm 一个目录。 */
export function runtimePaths() {
  const dir = runtimeDir()
  return {
    dir,
    binary: join(dir, RUNTIME_BINARY),
    manifest: join(dir, 'manifest.json'),
  }
}

/**
 * 清单记录「这份二进制是哪个版本、从哪来、校验值多少」。
 * 没有它就只能靠猜版本，而版本是 doctor 报告和问题排查的锚点。
 */
async function readManifest() {
  try {
    const raw = await readFile(runtimePaths().manifest, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeManifest(value) {
  const { dir, manifest } = runtimePaths()
  await mkdir(dir, { recursive: true })
  await writeFile(manifest, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** `tectonic --version` 输出形如 `Tectonic 0.17.0`（可能带额外行）。 */
function parseTectonicVersion(text) {
  const match = /Tectonic\s+([0-9][^\s]*)/i.exec(text ?? '')
  return match ? match[1] : null
}

/** `tectonic@0.17.0` → `0.17.0`。tag 前缀是上游习惯，别假设永远长这样。 */
function versionFromTag(tag) {
  const match = /(\d+\.\d+\.\d+(?:[-.+][0-9A-Za-z.]+)?)\s*$/.exec(String(tag ?? '').trim())
  if (match) return match[1]
  const stripped = String(tag ?? '').replace(/^tectonic[@\s-]*/i, '').trim()
  return stripped === '' ? null : stripped
}

/** 当前平台对应的上游目标三元组；不支持的组合返回 null。 */
export function describePlatform(platform = process.platform, arch = process.arch) {
  const entry = PLATFORM_TARGETS[`${platform}/${arch}`]
  if (!entry) return null
  return { platform, arch, target: entry.target, ext: entry.ext }
}

/** 拼出上游资产名，例如 `tectonic-0.17.0-x86_64-pc-windows-msvc.zip`。 */
export function assetNameFor(version, plat = describePlatform()) {
  if (!plat || !version) return null
  return `tectonic-${version}-${plat.target}.${plat.ext}`
}

// ---------------------------------------------------------------------------
// 解析：托管优先，其次 PATH
// ---------------------------------------------------------------------------

/** 跑一次 `--version` 验明正身：二进制存在但跑不起来（架构不符）也算不可用。 */
async function probeBinary(file, timeoutMs = 20_000) {
  const result = await run(file, ['--version'], { timeoutMs })
  if (isMissingBinary(result)) return null
  if (result.code !== 0) return null
  return { version: parseTectonicVersion(`${result.stdout}\n${result.stderr}`) }
}

/**
 * 托管运行时。清单缺失也接受——用户可能手动把 tectonic 丢进 runtimeDir，
 * 那种时候 `--version` 才是权威判据，清单只是元数据。
 */
async function resolveManaged() {
  const paths = runtimePaths()
  try {
    await access(paths.binary)
  } catch {
    return null
  }
  const probe = await probeBinary(paths.binary)
  if (!probe) return null
  const manifest = await readManifest()
  return {
    path: paths.binary,
    source: 'managed',
    version: manifest?.version ?? probe.version ?? null,
    managed: true,
  }
}

/** PATH 上的 tectonic。用 where/which 拿绝对路径，拿不到就退回裸名字。 */
async function resolveFromPath() {
  const probe = await probeBinary('tectonic')
  if (!probe) return null
  let resolved = null
  const which = await run(process.platform === 'win32' ? 'where' : 'which', ['tectonic'], { timeoutMs: 10_000 })
  if (which.code === 0) {
    const first = which.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    if (first) resolved = first
  }
  return {
    path: resolved ?? 'tectonic',
    source: 'path',
    version: probe.version,
    managed: false,
  }
}

/**
 * Resolve a usable Tectonic binary.
 *
 * Precedence: the copy this plugin manages under `$DSH_HOME/latex-kit/runtime`
 * first (it is the one whose version we control), then one already on PATH.
 *
 * @returns {Promise<{path: string, source: 'managed'|'path', version: string|null, managed: boolean} | null>}
 *   null when no Tectonic is available at all.
 */
export async function resolveTectonic() {
  const managed = await resolveManaged()
  if (managed) return managed
  return resolveFromPath()
}

/** 递归算目录字节数；`remove` 要报「释放了多少」。 */
export async function directorySize(dir) {
  let total = 0
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const item of items) {
    const full = join(dir, item.name)
    if (item.isDirectory()) {
      total += await directorySize(full)
    } else if (item.isFile()) {
      try {
        total += (await stat(full)).size
      } catch { /* 并发删除，忽略 */ }
    }
  }
  return total
}

/** `latex_runtime status` 用：一次问清楚托管侧与 PATH 侧。 */
export async function inspectTectonic() {
  const paths = runtimePaths()
  const manifest = await readManifest()
  const managed = await resolveManaged()

  let installed = false
  let sizeBytes = 0
  try {
    installed = (await stat(paths.binary)).isFile()
    if (installed) sizeBytes = await directorySize(paths.dir)
  } catch {
    installed = false
  }

  return {
    managed: {
      available: managed !== null,
      path: managed?.path ?? null,
      version: managed?.version ?? manifest?.version ?? null,
      source: managed?.source ?? null,
      installed,
      sizeBytes,
      manifest,
    },
    pathTectonic: await resolveFromPath(),
    runtimeDir: paths.dir,
    packageCacheDir: packageCacheDir(),
  }
}

// ---------------------------------------------------------------------------
// 上游元数据
// ---------------------------------------------------------------------------

/**
 * 读最新 release，挑出本平台那份资产。
 * digest 缺失时**直接失败**——没有校验值就不装（红线 1）。
 */
export async function resolveReleaseAsset({ signal, platform = process.platform, arch = process.arch } = {}) {
  const plat = describePlatform(platform, arch)
  if (!plat) {
    throw fail(
      'UNSUPPORTED_PLATFORM',
      `Tectonic 没有为 ${platform}/${arch} 提供官方构建；可选组合：${Object.keys(PLATFORM_TARGETS).join(', ')}`,
    )
  }

  let response
  try {
    response = await fetch(RELEASE_API, {
      signal,
      headers: { 'user-agent': 'dsh-latex-kit', accept: 'application/vnd.github+json' },
    })
  } catch (error) {
    if (signal?.aborted) throw fail('ABORTED', '操作已中止')
    throw fail('RELEASE_LOOKUP_FAILED', `无法查询 Tectonic 版本信息：${error?.message ?? error}`)
  }
  if (!response.ok) {
    throw fail('RELEASE_LOOKUP_FAILED', `GitHub 返回 HTTP ${response.status} ${response.statusText}`)
  }

  let release
  try {
    release = await response.json()
  } catch (error) {
    throw fail('RELEASE_LOOKUP_FAILED', `版本信息不是合法 JSON：${error?.message ?? error}`)
  }

  const version = versionFromTag(release?.tag_name)
  if (!version) throw fail('RELEASE_LOOKUP_FAILED', '版本信息里没有可用的 tag_name')

  const wanted = assetNameFor(version, plat)
  const asset = (release?.assets ?? []).find((item) => item?.name === wanted)
  if (!asset) throw fail('ASSET_NOT_FOUND', `上游 ${version} 没有发布 ${wanted}`)

  const digest = typeof asset.digest === 'string' ? asset.digest.trim() : ''
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest)
  if (!match) {
    throw fail('DIGEST_MISSING', `上游资产 ${wanted} 没有提供 sha256:… 格式的 digest，拒绝在没有校验的情况下安装`)
  }

  return {
    version,
    tag: release?.tag_name ?? null,
    name: wanted,
    size: typeof asset.size === 'number' ? asset.size : null,
    sha256: match[1].toLowerCase(),
    url: asset.browser_download_url,
  }
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk)
        callback()
      },
    }),
  )
  return hash.digest('hex')
}

/**
 * 流式下载并边下边算 sha256。
 * `expectedBytes` 只用于早期失败（Content-Length 不符就别白等了）；
 * 真正的判据永远是哈希。
 */
async function downloadTo(url, dest, { signal, expectedBytes = null, onProgress } = {}) {
  await mkdir(dirname(dest), { recursive: true })

  let response
  try {
    response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-latex-kit', accept: '*/*' },
    })
  } catch (error) {
    if (signal?.aborted) throw fail('ABORTED', '下载已中止')
    throw fail('DOWNLOAD_FAILED', `无法下载 Tectonic：${error?.message ?? error}`)
  }
  if (!response.ok) {
    throw fail('DOWNLOAD_FAILED', `下载 Tectonic 失败：HTTP ${response.status} ${response.statusText}`)
  }

  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw fail('DOWNLOAD_FAILED', `Tectonic 资产体积异常（${declared} 字节），已中止`)
  }
  if (expectedBytes !== null && Number.isFinite(declared) && declared !== expectedBytes) {
    throw fail('DOWNLOAD_FAILED', `下载体积与元数据不符：期望 ${expectedBytes} 字节，实际 ${declared} 字节`)
  }

  const hash = createHash('sha256')
  let bytes = 0
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(fail('DOWNLOAD_FAILED', 'Tectonic 资产超过允许的大小上限，已中止'))
        return
      }
      onProgress?.({ bytes, total: Number.isFinite(declared) ? declared : null })
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(dest))
  } catch (error) {
    if (signal?.aborted) throw fail('ABORTED', '下载已中止')
    throw error?.code ? error : fail('DOWNLOAD_FAILED', `下载中断：${error?.message ?? error}`)
  }

  return { sha256: hash.digest('hex'), bytes }
}

// ---------------------------------------------------------------------------
// 解压：ZIP 与 TAR.GZ 的最小读取器，只认普通文件
// ---------------------------------------------------------------------------

/**
 * 归档里的条目名必须当成不可信输入：`..\..\windows\system32\x.exe` 这种
 * 路径穿越在解压器上是真实的攻击面。返回 null 表示这个条目直接丢弃。
 */
export function resolveArchiveEntry(root, entryName) {
  const normalised = String(entryName).replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalised === '' || normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) return null
  const segments = normalised.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return join(root, ...segments)
}

/** ZIP：走中央目录而不是顺序扫 local header——顺序扫会被数据里的假签名骗到。 */
export function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  const floor = Math.max(0, buffer.length - 0xffff - 22)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw fail('ARCHIVE_INVALID', '不是合法的 zip：找不到中央目录结尾')

  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw fail('ARCHIVE_INVALID', 'zip 使用了 ZIP64，当前解压器不支持')
  }

  const entries = []
  let cursor = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw fail('ARCHIVE_INVALID', 'zip 中央目录损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue // 目录条目；写文件时按需建目录

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw fail('ARCHIVE_INVALID', `zip 条目 ${name} 的 local header 损坏`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = inflateRawSync(raw)
    } else {
      throw fail('ARCHIVE_INVALID', `zip 条目 ${name} 使用了不支持的压缩方式 ${method}`)
    }
    entries.push({ name, data })
  }
  return entries
}

function readTarString(header, offset, length) {
  const slice = header.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function readTarOctal(header, offset, length) {
  const text = readTarString(header, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** TAR：只认普通文件；pax/长名扩展（'x' 'g' 'L'）跳过，tectonic 归档里没有。 */
export function readTarEntries(buffer) {
  const entries = []
  let offset = 0
  let sawHeader = false
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // 补零，归档结束
    sawHeader = true
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const size = readTarOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] || 0x30)
    const dataStart = offset + 512
    const padded = Math.ceil(size / 512) * 512

    if (typeflag === '0' || typeflag === '\u0000' || typeflag === '7') {
      const full = prefix ? `${prefix}/${name}` : name
      entries.push({ name: full, data: Buffer.from(buffer.subarray(dataStart, dataStart + size)) })
    }
    offset = dataStart + padded
  }
  if (!sawHeader) throw fail('ARCHIVE_INVALID', '不是合法的 tar：读不到任何条目')
  return entries
}

/** 按扩展名选读取器；两条路径都返回 `[{name, data}]`。 */
export function extractEntries(buffer, archiveName) {
  const lower = String(archiveName).toLowerCase()
  if (lower.endsWith('.zip')) return readZipEntries(buffer)
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return readTarEntries(gunzipSync(buffer))
  throw fail('ARCHIVE_INVALID', `不认识归档格式：${archiveName}`)
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

/**
 * 装一份托管 Tectonic。
 *
 * 顺序是刻意的：
 *   下载到 staging（.part）→ 校验 sha256 → 解压到 staging → 搬进 runtimeDir
 *   → `--version` 验证 → 写清单。
 *
 * 任何一步失败都把 staging 与 runtimeDir 清干净：宁可「没装」，也不要留个
 * 半成品让下次 `--version` 偶发失败——那是最难排查的一种状态（验收标准 3）。
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {phase: string, bytes?: number, total?: number|null}) => void} [options.onProgress]
 * @param {string} [options.archivePath] 已在本地的归档，跳过下载（离线镜像 / 回归测试）
 * @param {string} [options.expectedSha256] 覆盖期望哈希；只为验证「校验失败必须清盘」而存在
 */
export async function installTectonic(options = {}) {
  const { signal, onProgress, archivePath = null, expectedSha256 = null } = options
  const paths = runtimePaths()
  const staging = stagingDir()
  await mkdir(staging, { recursive: true })

  const asset = archivePath
    ? {
        version: options.version ?? versionFromTag(options.tag ?? ''),
        tag: options.tag ?? null,
        name: options.name ?? archivePath.split(/[\\/]/).pop(),
        size: null,
        sha256: expectedSha256,
        url: `file://${archivePath}`,
      }
    : await resolveReleaseAsset({ signal })

  const wantedSha = String(expectedSha256 ?? asset.sha256 ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(wantedSha)) {
    throw fail('DIGEST_MISSING', '没有可用的 sha256 校验值，拒绝安装')
  }

  const partFile = join(staging, `${asset.name}.part`)
  const extractDir = join(staging, `extract-${process.pid}-${Date.now()}`)

  const cleanup = async () => {
    await rm(partFile, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    // ---- 1. 取到本地归档 -------------------------------------------------
    onProgress?.({ phase: 'download' })
    if (archivePath) {
      await copyFile(archivePath, partFile)
    } else {
      await downloadTo(asset.url, partFile, {
        signal,
        expectedBytes: asset.size,
        onProgress: (progress) => onProgress?.({ phase: 'download', ...progress }),
      })
    }

    // ---- 2. 校验（红线：不一致就不留文件）--------------------------------
    onProgress?.({ phase: 'verify' })
    const actualSha = await sha256File(partFile)
    if (actualSha !== wantedSha) {
      await unlink(partFile).catch(() => {})
      throw fail('SHA256_MISMATCH', `sha256 校验失败，已删除下载的文件。期望 ${wantedSha}，实际 ${actualSha}`, {
        expected: wantedSha,
        actual: actualSha,
      })
    }

    // ---- 3. 解压到 staging -----------------------------------------------
    onProgress?.({ phase: 'extract' })
    const archiveBuffer = await readFile(partFile)
    const entries = extractEntries(archiveBuffer, asset.name)
    if (entries.length === 0) throw fail('ARCHIVE_INVALID', `${asset.name} 里没有任何文件`)

    await mkdir(extractDir, { recursive: true })
    let binaryEntry = null
    for (const entry of entries) {
      const target = resolveArchiveEntry(extractDir, entry.name)
      if (!target) continue
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
      if (process.platform !== 'win32') await chmod(target, 0o755)
      // 上游顶层布局改过：有时是 `tectonic`，有时是 `tectonic-0.17.0/tectonic`。
      // 按 basename 找比按固定路径找耐改。
      if (!binaryEntry && entry.name.split(/[\\/]/).pop() === RUNTIME_BINARY) binaryEntry = target
    }
    if (!binaryEntry) throw fail('ARCHIVE_INVALID', `${asset.name} 里找不到 ${RUNTIME_BINARY}`)

    // ---- 4. 落位（先清旧版本，避免两个 tectonic 并存）--------------------
    onProgress?.({ phase: 'install' })
    await rm(paths.dir, { recursive: true, force: true })
    await mkdir(paths.dir, { recursive: true })
    await copyFile(binaryEntry, paths.binary)
    if (process.platform !== 'win32') await chmod(paths.binary, 0o755)

    // ---- 5. 验证可执行 ---------------------------------------------------
    onProgress?.({ phase: 'verify-binary' })
    const probe = await probeBinary(paths.binary, 30_000)
    if (!probe) {
      await rm(paths.dir, { recursive: true, force: true }).catch(() => {})
      throw fail(
        'BINARY_NOT_RUNNABLE',
        `装好的 ${RUNTIME_BINARY} 跑不起来（--version 失败），已回滚。多半是平台或架构不匹配。`,
      )
    }

    const version = asset.version ?? probe.version ?? null
    await writeManifest({
      version,
      asset: asset.name,
      sha256: actualSha,
      source: asset.url,
      installedAt: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
    })

    await cleanup()
    return {
      path: paths.binary,
      version,
      reportedVersion: probe.version,
      sha256: actualSha,
      asset: asset.name,
      sizeBytes: await directorySize(paths.dir),
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** 删掉托管运行时和包缓存，返回释放的字节数。 */
export async function removeTectonic() {
  const targets = [runtimeDir(), packageCacheDir()]
  let freedBytes = 0
  const removed = []
  for (const dir of targets) {
    const bytes = await directorySize(dir)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    freedBytes += bytes
    removed.push({ path: dir, bytes })
  }
  return { freedBytes, removed }
}

/** 人类可读的字节数；工具层展示用。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
