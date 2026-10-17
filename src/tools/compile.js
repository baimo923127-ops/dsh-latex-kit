/**
 * latex_compile — build a TeX project and return a structured report.
 *
 * 报告是给 agent 读的，不是给人读的：`errors` 必须带得上文件和行号，否则
 * 下一轮修改只能靠猜。给人看的那一份在 render 里。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { compileProject } from '../lib/tex.js'

/** 默认编译预算。Tectonic 首次要拉宏包，纯本地项目几秒就好。 */
const DEFAULT_TIMEOUT_MS = 180_000

function renderCompile(value) {
  const lines = []

  if (value.ok) {
    lines.push(`编译成功  ${value.pages === null ? '（页数未知）' : `${value.pages} 页`}  用时 ${value.durationMs} ms`)
    lines.push(`引擎 ${value.engine}`)
    if (value.pdfPath) lines.push(`PDF  ${value.pdfPath}`)
  } else {
    lines.push(`编译失败  用时 ${value.durationMs} ms`)
    if (value.engine) lines.push(`引擎 ${value.engine}`)
    if (value.hint) lines.push(value.hint)
  }

  if (value.engineReason) lines.push(`为什么用 ${value.engine ?? '这个引擎'}：${value.engineReason}`)

  if (value.errors.length > 0) {
    lines.push('')
    lines.push(`错误 ${value.errors.length} 处：`)
    for (const error of value.errors) {
      const where = error.file ? `${error.file}${error.line === null ? '' : `:${error.line}`}` : error.line === null ? '位置未知' : `第 ${error.line} 行`
      lines.push(`  ${where}  ${error.message}`)
    }
  }

  if (value.warnings.count > 0) {
    lines.push('')
    lines.push(`警告 ${value.warnings.count} 条${value.warnings.samples.length < value.warnings.count ? `（只列前 ${value.warnings.samples.length} 条）` : ''}：`)
    for (const sample of value.warnings.samples) lines.push(`  ${sample.message}`)
  }

  if (value.undefinedRefs.count > 0 || value.undefinedCitations.count > 0) {
    lines.push('')
    if (value.undefinedRefs.count > 0) {
      lines.push(`未定义引用 ${value.undefinedRefs.count} 个：${value.undefinedRefs.items.map((item) => item.name).join(', ')}`)
    }
    if (value.undefinedCitations.count > 0) {
      lines.push(`未定义文献 ${value.undefinedCitations.count} 个：${value.undefinedCitations.items.map((item) => item.name).join(', ')}`)
    }
  }

  if (value.overfull > 0) {
    lines.push('')
    lines.push(`overfull box ${value.overfull} 个（版面溢出，不阻塞编译）`)
  }

  if (value.rerunSuggested && value.ok) {
    lines.push('')
    lines.push('日志提示还需要再跑一遍（交叉引用/文献还没稳定）。')
  }

  if (value.logTail) {
    lines.push('')
    lines.push('日志尾部：')
    lines.push(value.logTail)
  }

  if (value.buildDir) {
    lines.push('')
    lines.push(`中间文件留在 ${value.buildDir}`)
  }

  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../index.js').Shared} shared
 */
export function register(ctx, shared) {
  ctx.tools.register(defineTool({
    name: 'latex_compile',
    description:
      '编译一个 LaTeX 项目并返回结构化报告（ok / 实际引擎 / PDF 路径 / 带文件与行号的错误 / 警告 / '
      + '未定义引用与文献 / overfull 计数 / 页数 / 耗时 / 日志尾部）。需要 shell escape 或 biber 的项目会自动'
      + '回落到 latexmk，但那要求本机有完整 TeX Live；没有引擎时会明确告诉你先跑 latex_runtime install。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '入口 .tex 文件的绝对路径',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'tectonic', 'latexmk'],
        description: 'auto（默认）按项目特性挑；指定 tectonic 或 latexmk 则照做，不会偷偷换引擎',
      },
      timeoutMs: {
        type: 'number',
        description: `编译超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}`,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderCompile(value) }],
    },
    async execute(args, exec) {
      const report = await compileProject(shared, {
        entryPath: args.path,
        engine: args.engine ?? 'auto',
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: exec.signal,
      })

      await shared.log(
        'compile',
        `${report.ok ? 'ok' : 'fail'} engine=${report.engine ?? 'none'} path=${args.path} ms=${report.durationMs}`
          + `${report.errors.length > 0 ? ` errors=${report.errors.length}` : ''}`,
      )

      return report
    },
    timeoutMs: DEFAULT_TIMEOUT_MS + 120_000,
  }))
}
