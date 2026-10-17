/**
 * latex_render — TeX 公式渲染成自包含 SVG，离线，不需要任何 TeX 引擎。
 *
 * OWNER: agent C (rendering).
 *
 * 渲染库 `mathjax-full` 是**可选依赖**，刻意不写进 package.json：
 *   - 它解包 32.7MB（真正被加载的只有 2.3MB，但那仍然不该压在每次插件安装上）；
 *   - 用户可能只要编译/文献功能，公式渲染一次都用不上。
 * 所以这里全程动态加载：没装的时候工具必须能说话，而不是让整个插件加载失败。
 * 注意 `src/lib/formula.js` 里也**没有**任何顶层 import 这个包。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  ENGINE_PACKAGE,
  ENGINE_VERSION,
  EngineUnavailableError,
  RenderError,
  contentHash,
  loadEngine,
  readTexError,
  resolveOutPath,
  scanExternalRefs,
  stripDelimiters,
  toStandaloneSvg,
} from '../lib/formula.js'

/** 插件包根目录：用户把引擎装进插件自己的 node_modules 时，从这儿能解析到。 */
function pluginRoot() {
  return fileURLToPath(new URL('../../', import.meta.url))
}

/**
 * 引擎查找顺序：插件托管的 engine 目录优先（可整体删除、和插件升级解耦），
 * 其次是插件自己的 node_modules（`npm install` 在包里装的）。
 */
function engineRoots(shared) {
  const roots = []
  try {
    roots.push(join(shared.paths.kitHome(), 'engine'))
  } catch { /* paths 不可用时退回下一项 */ }
  roots.push(pluginRoot())
  return roots
}

function engineTag(engine) {
  if (!engine) return null
  return engine.version ? `${engine.name} ${engine.version}` : engine.name
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`
}

/** 失败一律返回结构化结果，不抛原生异常：调用方要能拿它写人话。 */
function failure(code, message, extra = {}) {
  return { ok: false, error: code, message, format: 'svg', warnings: [], ...extra }
}

function missingEngineResult(error, roots, shared) {
  const kitEngine = join(shared.paths.kitHome(), 'engine')
  const install = [
    `npm install --prefix "${kitEngine}" ${ENGINE_PACKAGE}@${ENGINE_VERSION}`,
    `npm install ${ENGINE_PACKAGE}@${ENGINE_VERSION}   # 在 ${pluginRoot()} 下执行`,
  ]
  return failure('engine-unavailable', error.message, {
    missing: [ENGINE_PACKAGE],
    install,
    searched: roots,
    warnings: ['渲染引擎未安装：本次没有产出文件，插件的其他工具不受影响'],
  })
}

const DESCRIPTION = [
  '把 TeX 公式渲染成自包含 SVG 文件（字形已转成 path，不引用任何外部字体），可直接插进论文/PPT/网页。',
  '完全离线，不需要 TeX 引擎。渲染引擎 mathjax-full 是可选依赖：没装时返回明确的安装指引，不会报错崩掉。',
].join('')

function renderText(value) {
  const lines = []
  if (value.ok) {
    lines.push('公式已渲染成 SVG')
    lines.push(`  文件  ${value.path}`)
    lines.push(`  体积  ${formatBytes(value.bytes)}`)
    lines.push(`  引擎  ${value.engine ?? '未知'}`)
    lines.push(`  自包含  ${value.selfContained ? '是（字形是 path，无外部字体引用）' : '否 —— 见下方警告'}`)
    if (value.warnings?.length) {
      lines.push('  警告')
      for (const warning of value.warnings) lines.push(`    - ${warning}`)
    }
    return lines.join('\n')
  }

  if (value.error === 'engine-unavailable') {
    lines.push('公式没有渲染：本机缺少渲染引擎 mathjax-full。')
    lines.push('')
    lines.push('这不是错误，只是可选依赖还没装。二选一：')
    for (const command of value.install ?? []) lines.push(`  ${command}`)
    lines.push('')
    lines.push('装完不用重启插件，下一次调用会自动发现。装好后 latex_render 可以把任意公式')
    lines.push('离线渲染成自包含 SVG：字形转 path、不依赖任何字体文件，矢量可无限缩放。')
    return lines.join('\n')
  }

  if (value.error === 'tex-error') {
    lines.push(`公式没有渲染：TeX 解析失败 —— ${value.message}`)
    if (value.tex) lines.push(`  源码  ${value.tex}`)
    lines.push('  常见原因：花括号不配对、命令拼错、用了未装载的宏包（目前只装载常用数学包）。')
    return lines.join('\n')
  }

  if (value.error === 'unsupported-format') {
    lines.push(`没有渲染：暂不支持 format="${value.format}"。`)
    lines.push('latex_render 目前只产出 svg —— 它是唯一能保证「自包含、无字体依赖」的矢量格式。')
    lines.push('要位图请先导出 svg 再用外部工具转换。')
    return lines.join('\n')
  }

  lines.push(`公式没有渲染：${value.message ?? value.error}`)
  if (value.warnings?.length) {
    for (const warning of value.warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../index.js').Shared} shared
 */
export function register(ctx, shared) {
  ctx.tools.register(
    defineTool({
      name: 'latex_render',
      description: DESCRIPTION,
      parameters: {
        tex: {
          type: 'string',
          required: true,
          description: '公式源码。可带可不带 $ / $$ / \\[ \\] 包裹，例如 \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
        },
        display: {
          type: 'boolean',
          default: true,
          description: 'true 行间公式（默认），false 行内公式：只影响排版尺寸，不影响输出格式',
        },
        out: {
          type: 'string',
          description: '输出路径。相对路径按插件的 build 目录解析；要落到工程里请给绝对路径。不填则用内容哈希命名，同一公式重复渲染仍落同一个文件',
        },
        format: {
          type: 'string',
          default: 'svg',
          description: '目前只支持 svg。传别的值会明确报「暂不支持」，不会静默当成 svg',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            bytes: { type: 'number' },
            format: { type: 'string' },
            engine: { type: 'string' },
            selfContained: { type: 'boolean' },
            warnings: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      execute: async (args, exec) => {
        const display = args.display !== false
        const format = String(args.format ?? 'svg').trim().toLowerCase() || 'svg'

        if (format !== 'svg') {
          return failure('unsupported-format', `暂不支持 format="${format}"，latex_render 目前只产出 svg`, { format })
        }
        if (exec?.signal?.aborted) return failure('aborted', '操作已中止')

        const tex = stripDelimiters(args.tex)
        if (tex === '') return failure('empty-tex', '公式源码是空的', { tex })

        let target
        try {
          target = resolveOutPath(args.out, shared.paths.buildDir(), contentHash(tex, display))
        } catch (error) {
          if (error instanceof RenderError) return failure(error.code, error.message, { tex })
          return failure('bad-output-path', `输出路径不可用：${error?.message ?? error}`, { tex })
        }

        const roots = engineRoots(shared)
        let loaded
        try {
          loaded = await loadEngine(roots)
        } catch (error) {
          if (error instanceof EngineUnavailableError) return missingEngineResult(error, roots, shared)
          return failure('engine-error', `渲染引擎加载失败：${error?.message ?? error}`)
        }

        const engine = engineTag(loaded.engine)

        let html
        try {
          html = loaded.engine.render(tex, { display })
        } catch (error) {
          return failure('render-failed', `渲染失败：${error?.message ?? error}`, { engine, tex })
        }

        // MathJax 把 TeX 语法错误变成图里的红字而不是抛异常；不主动查就会
        // 把一张「Missing close brace」的废图当成成功交付。
        const texError = readTexError(html)
        if (texError) return failure('tex-error', texError, { engine, tex })

        let standalone
        try {
          standalone = toStandaloneSvg(html)
        } catch (error) {
          return failure('bad-svg', `渲染结果整形失败：${error?.message ?? error}`, { engine })
        }

        const violations = scanExternalRefs(standalone.svg)
        const warnings = [...loaded.warnings, ...standalone.warnings]
        if (violations.length > 0) {
          warnings.push(`产物里出现外部引用（${violations.join('、')}），这份 SVG 不是自包含的`)
        }

        try {
          await mkdir(dirname(target.path), { recursive: true })
          await writeFile(target.path, standalone.svg, 'utf8')
        } catch (error) {
          return failure('write-failed', `写文件失败：${target.path} —— ${error?.message ?? error}`, { engine })
        }

        const bytes = Buffer.byteLength(standalone.svg, 'utf8')
        void shared.log('render', `latex_render → ${target.path} (${bytes} B, ${engine ?? 'unknown'}, display=${display})`)

        return {
          ok: true,
          path: target.path,
          bytes,
          format: 'svg',
          engine,
          selfContained: violations.length === 0,
          warnings,
        }
      },
      timeoutMs: 60_000,
    }),
  )
}
