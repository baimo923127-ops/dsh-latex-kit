/**
 * latex_runtime — inspect, install and remove the plugin-managed Tectonic.
 *
 * 这一组动作是「让一台完全没装 TeX 的机器能编译」的前半段：把 Tectonic 装到
 * 插件自己的目录里，不碰系统 PATH、不碰注册表、不装 GB 级的东西。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  formatBytes,
  inspectTectonic,
  installTectonic,
  removeTectonic,
  resolveReleaseAsset,
} from '../lib/tectonic.js'

/** 下载 21MB 加上解压与首次启动，两分钟级；给足余量但不无限等。 */
const INSTALL_TIMEOUT_MS = 15 * 60_000

function renderStatus(value) {
  const lines = []
  const managed = value.managed ?? {}
  if (managed.available) {
    lines.push(`托管 Tectonic：已就位  v${managed.version ?? '未知版本'}  (${formatBytes(managed.sizeBytes ?? 0)})`)
    lines.push(`  路径 ${managed.path}`)
  } else if (managed.installed) {
    lines.push(`托管 Tectonic：文件在 ${managed.path}，但跑不起来（--version 失败），建议重新安装`)
  } else {
    lines.push('托管 Tectonic：未安装')
  }
  lines.push(`运行时目录 ${value.runtimeDir}`)
  lines.push(`宏包缓存 ${value.packageCacheDir}`)
  lines.push('')
  lines.push(
    value.pathTectonic
      ? `PATH 上的 tectonic：${value.pathTectonic.path}  v${value.pathTectonic.version ?? '未知版本'}`
      : 'PATH 上的 tectonic：没有',
  )
  if (!managed.available && !value.pathTectonic) {
    lines.push('')
    lines.push('两个来源都没有 Tectonic。运行 latex_runtime install 装托管版本（约 21MB）。')
  }
  return lines.join('\n')
}

function renderInstall(value) {
  if (!value.ok) {
    const lines = [`安装失败：${value.error}`]
    if (value.code === 'SHA256_MISMATCH') {
      lines.push(`  期望 sha256 ${value.expected}`)
      lines.push(`  实际 sha256 ${value.actual}`)
      lines.push('  下载的文件已删除，磁盘上没留下任何东西。这通常意味着传输被中间人改写，或上游重新发布了同一版本。')
    }
    if (value.hint) lines.push(value.hint)
    return lines.join('\n')
  }
  if (value.alreadyInstalled) {
    return `托管 Tectonic 已经装好了：v${value.version ?? '未知版本'}，${formatBytes(value.sizeBytes ?? 0)}\n  路径 ${value.path}\n要重新下载请传 force: true。`
  }
  return [
    `已安装托管 Tectonic v${value.version ?? '未知版本'}  (${formatBytes(value.sizeBytes ?? 0)})`,
    `  路径 ${value.path}`,
    `  来源 ${value.asset}`,
    `  校验 sha256:${value.sha256}`,
    '现在 latex_compile 会直接用它。',
  ].join('\n')
}

function renderRemove(value) {
  if (!value.ok) return `删除失败：${value.error}`
  const lines = [`已释放 ${formatBytes(value.freedBytes)}`]
  for (const entry of value.removed ?? []) {
    lines.push(`  ${entry.path}  ${formatBytes(entry.bytes)}`)
  }
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../index.js').Shared} shared
 */
export function register(ctx, shared) {
  ctx.tools.register(defineTool({
    name: 'latex_runtime',
    description:
      '管理本插件托管的 Tectonic 运行时。action=status 报告是否就位/版本/路径/体积；'
      + 'action=install 从 GitHub 下载官方资产、校验 sha256、解压到 $DSH_HOME/latex-kit 并验证可执行；'
      + 'action=remove 删掉运行时与宏包缓存。绝不安装 TeX Live。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'install', 'remove'],
        description: 'status 只报告不改变任何东西；install 下载并安装；remove 删除并报告释放的空间',
      },
      force: {
        type: 'boolean',
        description: 'install 时即使已经装好也重新下载（默认 false，避免误触二十多兆的下载）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const text =
          value.action === 'install'
            ? renderInstall(value)
            : value.action === 'remove'
              ? renderRemove(value)
              : renderStatus(value)
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const action = args.action

      if (action === 'status') {
        const info = await inspectTectonic()
        return { ok: true, action, ...info }
      }

      if (action === 'remove') {
        try {
          const result = await removeTectonic()
          await shared.log('runtime', `removed runtime+cache, freed ${result.freedBytes} bytes`)
          return { ok: true, action, ...result }
        } catch (error) {
          await shared.log('runtime', `remove failed: ${error?.message ?? error}`)
          return { ok: false, action, error: String(error?.message ?? error) }
        }
      }

      // ---- install ------------------------------------------------------
      const existing = await inspectTectonic()
      if (existing.managed.available && args.force !== true) {
        return {
          ok: true,
          action,
          alreadyInstalled: true,
          path: existing.managed.path,
          version: existing.managed.version,
          sizeBytes: existing.managed.sizeBytes,
        }
      }

      // 先问上游要资产信息：平台不支持、没有 digest 这些情况在这里就该失败，
      // 而不是等下载完二十多兆再说。
      try {
        const asset = await resolveReleaseAsset({ signal: exec.signal })
        await shared.log('runtime', `installing tectonic ${asset.version} from ${asset.name} (sha256:${asset.sha256})`)
      } catch (error) {
        await shared.log('runtime', `release lookup failed: ${error?.code ?? ''} ${error?.message ?? error}`)
        return {
          ok: false,
          action,
          code: error?.code ?? 'RELEASE_LOOKUP_FAILED',
          error: String(error?.message ?? error),
          hint: '检查网络能否访问 api.github.com；也可以自己把 tectonic 放到 runtimeDir 里，resolveTectonic 会认它。',
        }
      }

      let lastLogged = 0
      try {
        const result = await installTectonic({
          signal: exec.signal,
          onProgress: (progress) => {
            if (progress.phase !== 'download' || typeof progress.bytes !== 'number') return
            // 每 8MB 记一行，够诊断又不至于把日志刷成一片。
            if (progress.bytes - lastLogged < 8 * 1024 * 1024) return
            lastLogged = progress.bytes
            void shared.log('runtime', `download ${formatBytes(progress.bytes)}${progress.total ? ` / ${formatBytes(progress.total)}` : ''}`)
          },
        })
        await shared.log('runtime', `installed tectonic ${result.version} at ${result.path}`)
        return { ok: true, action, alreadyInstalled: false, ...result }
      } catch (error) {
        await shared.log('runtime', `install failed: ${error?.code ?? ''} ${error?.message ?? error}`)
        return {
          ok: false,
          action,
          code: error?.code ?? 'INSTALL_FAILED',
          error: String(error?.message ?? error),
          expected: error?.expected,
          actual: error?.actual,
        }
      }
    },
    timeoutMs: INSTALL_TIMEOUT_MS,
  }))
}
