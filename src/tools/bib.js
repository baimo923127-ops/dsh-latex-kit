/**
 * bib_lint / bib_fill / cite_audit — 文献质量三件套。
 *
 * 全部是纯文本 + HTTP：不需要任何 TeX 引擎，没装 LaTeX 的机器上照样能用。
 * 真正的逻辑都在 src/lib/bibtex.js（解析/体检/规范化/补全/引用比对）
 * 和 src/lib/crossref.js（Crossref / Semantic Scholar），这里只做宿主接线、读写文件和
 * 给人看的文本渲染——这样纯逻辑可以脱离 DSH 单独单测。
 *
 * OWNER: agent B (bibliography).
 */

import { readFile, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  applyFills,
  auditCites,
  entryDoi,
  entryTitle,
  existingFields,
  extractCites,
  lintBib,
  mergeRecord,
  parseBib,
  verifyFill,
} from '../lib/bibtex.js'
import { describeStatus, lookupEntry } from '../lib/crossref.js'

/** bib_fill 会尝试补的字段。顺序无所谓，mergeRecord 只取「条目里没有的」。 */
const FILLABLE_FIELDS = [
  'author', 'editor', 'title', 'journal', 'booktitle', 'year',
  'volume', 'number', 'pages', 'publisher', 'doi', 'url', 'issn', 'isbn',
]

const LOOKUP_BUDGET_MS = 100_000
const LOOKUP_TIMEOUT_MS = 8_000
const DEFAULT_FILL_LIMIT = 25

function resolvePath(input) {
  return resolve(String(input))
}

function relativeToCwd(file) {
  const cwd = process.cwd()
  return file.startsWith(cwd + sep) ? file.slice(cwd.length + 1) : file
}

/** 读 .bib：去掉 BOM，统一换行交给调用方决定（这里原样保留，只去 BOM）。 */
async function readText(file) {
  const text = await readFile(file, 'utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 先写临时文件再 rename：中途失败也不会留下半个 .bib。
 * 同目录下 rename 才是原子的（跨盘会退化成复制）。
 */
async function writeAtomic(file, contents) {
  const temp = join(dirname(file), `.${Date.now().toString(36)}-${process.pid}.latex-kit.tmp`)
  try {
    await writeFile(temp, contents, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function fileErrorText(error) {
  if (error?.code === 'ENOENT') return '文件不存在'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '没有权限读写这个文件'
  if (error?.code === 'EISDIR') return '给的是一个目录，需要具体的文件路径'
  return error?.message ?? String(error)
}

function severityTag(severity) {
  if (severity === 'error') return '[error]'
  if (severity === 'warning') return '[warn] '
  return '[info] '
}

/* ------------------------------------------------------------------ *
 * bib_lint
 * ------------------------------------------------------------------ */

function renderLint(value) {
  if (value.error) return `bib_lint 失败：${value.error}\n路径：${value.path ?? '(未知)'}`
  const lines = []
  lines.push(`BibTeX 体检 · ${value.path}`)
  lines.push(`条目 ${value.entries} 条 · 问题 ${value.problems.length} 处 · 结论：${value.ok ? '通过' : '未通过'}`)
  if (value.parseError) lines.push(`解析失败：${value.parseError}`)
  if (value.problems.length > 0) {
    lines.push('')
    for (const problem of value.problems) {
      const where = problem.line ? `第 ${problem.line} 行` : '行号未知'
      const key = problem.key ? ` ${problem.key}` : ''
      lines.push(`${severityTag(problem.severity)} ${problem.type}${key} · ${where}`)
      lines.push(`        ${problem.message}`)
    }
  }
  if (value.fixed.length > 0) {
    lines.push('')
    lines.push(value.written ? `已规范化并写回 ${value.fixed.length} 处：` : `可规范化 ${value.fixed.length} 处（write=false，未落盘）：`)
    for (const item of value.fixed) lines.push(`  - ${item.key}（第 ${item.line} 行）：${item.detail}`)
  } else {
    lines.push('')
    lines.push('格式无需规范化。')
  }
  return lines.join('\n')
}

async function runLint(args, shared) {
  const file = resolvePath(args.path)
  const shown = relativeToCwd(file)
  let text
  try {
    text = await readText(file)
  } catch (error) {
    return { ok: false, path: shown, entries: 0, problems: [], fixed: [], written: false, error: fileErrorText(error) }
  }

  const lint = lintBib(text)
  const write = args.write === true
  const parseError = lint.parsed.ok ? null : (lint.problems.find((p) => p.type === 'parse-error')?.message ?? '无法解析')

  let written = false
  let writeError = null
  if (write) {
    // 解析失败时绝不落盘：规范化结果建立在半解析的条目上，写出去就是毁文件
    if (!lint.parsed.ok) writeError = '解析失败，拒绝写入（避免丢失内容）'
    else if (lint.normalizedChanged) {
      try {
        await writeAtomic(file, lint.normalizedText)
        written = true
        await shared.logSafe('bib_lint', `normalized ${shown}: ${lint.changes.length} change(s)`)
      } catch (error) {
        writeError = fileErrorText(error)
      }
    }
  }

  const value = {
    ok: lint.ok,
    path: shown,
    entries: lint.entries,
    entryList: lint.entryList,
    problems: lint.problems,
    fixed: lint.changes,
    written,
    parseError,
    normalized: lint.normalizedChanged,
  }
  if (writeError) value.writeError = writeError
  return value
}

/* ------------------------------------------------------------------ *
 * bib_fill
 * ------------------------------------------------------------------ */

function renderFill(value) {
  if (value.error) return `bib_fill 失败：${value.error}\n路径：${value.path ?? '(未知)'}`
  const lines = []
  lines.push(`文献补全 · ${value.path}`)
  lines.push(`条目 ${value.entries} 条 · 可补 ${value.filled.length} 条 · 跳过 ${value.skipped.length} 条 · 数据源 ${value.source}`)
  if (value.refused) {
    lines.push('')
    lines.push(`拒绝写入：${value.refused}`)
  }
  if (value.filled.length > 0) {
    lines.push('')
    lines.push(value.written ? '已写入的字段：' : '会补的字段（write=false，未落盘）：')
    for (const item of value.filled) {
      lines.push(`  - ${item.key}  ←  ${item.source}${item.via ? ` (${item.via})` : ''}`)
      for (const [name, val] of Object.entries(item.fields)) lines.push(`      ${name} = {${val}}`)
    }
  }
  if (value.skipped.length > 0) {
    lines.push('')
    lines.push('跳过的条目：')
    for (const item of value.skipped) lines.push(`  - ${item.key || '(整个文件)'}：${item.reason}`)
  }
  if (value.messages.length > 0) {
    lines.push('')
    for (const message of value.messages) lines.push(`注意：${message}`)
  }
  return lines.join('\n')
}

/**
 * 找「缺字段且查得到线索」的条目。
 * 已有值哪怕是脏的也不算缺——红线是不覆盖。
 */
function fillTargets(entries) {
  const targets = []
  for (const entry of entries) {
    // 用「出现过的字段」判断是否缺失：空值字段也算存在，否则会补出重复字段
    const present = existingFields(entry)
    const missing = FILLABLE_FIELDS.filter((name) => !present.has(name))
    if (missing.length === 0) continue
    const doi = entryDoi(entry)
    const title = entryTitle(entry)
    targets.push({ entry, key: entry.key, missing, doi, title })
  }
  return targets
}

async function runFill(args, exec, shared) {
  const file = resolvePath(args.path)
  const shown = relativeToCwd(file)
  const source = args.source === 'semantic-scholar' ? 'semantic-scholar' : 'crossref'
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : DEFAULT_FILL_LIMIT

  let text
  try {
    text = await readText(file)
  } catch (error) {
    return { ok: false, error: fileErrorText(error), path: shown, filled: [], skipped: [], written: false, entries: 0, source, messages: [] }
  }

  // 红线 4：解析不了就整体拒绝，一个字节都不写
  const parsed = parseBib(text)
  if (!parsed.ok) {
    const reason = parsed.errors[0]?.message ?? '无法解析'
    await shared.logSafe('bib_fill', `refused ${shown}: ${reason}`)
    return {
      ok: false,
      path: shown,
      entries: parsed.entries.length,
      filled: [],
      skipped: [],
      written: false,
      source,
      messages: [`整个 .bib 无法完整解析（${reason}），已整体拒绝写入`],
      refused: `解析失败：${reason}`,
      parseError: reason,
    }
  }

  const targets = fillTargets(parsed.entries)
  const filled = []
  const skipped = []
  const messages = []
  const degradedStatuses = new Set()
  const deadline = Date.now() + LOOKUP_BUDGET_MS
  const attempted = targets.slice(0, limit)

  for (const target of targets.slice(limit)) {
    skipped.push({ key: target.key, reason: `超出本次数量上限（limit=${limit}）` })
  }

  for (const target of attempted) {
    if (exec?.signal?.aborted) {
      skipped.push({ key: target.key, reason: '任务被取消' })
      continue
    }
    if (Date.now() > deadline) {
      skipped.push({ key: target.key, reason: `超出本次时间预算（${LOOKUP_BUDGET_MS / 1000} 秒）` })
      continue
    }
    if (!target.doi && !target.title) {
      skipped.push({ key: target.key, reason: '既没有 DOI 也没有标题，无从查询' })
      continue
    }

    let lookup
    try {
      lookup = await lookupEntry({
        doi: target.doi,
        title: target.title,
        entryType: target.entry.type,
        source,
        signal: exec?.signal,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      })
    } catch (error) {
      // 客户端内部已经把网络失败翻译成状态了，走到这里属于意外，仍然不往上抛
      skipped.push({ key: target.key, reason: `查询异常：${error?.message ?? String(error)}` })
      continue
    }

    if (!lookup.ok) {
      if (lookup.status === 'unreachable' || lookup.status === 'timeout') degradedStatuses.add(lookup.status)
      skipped.push({
        key: target.key,
        reason: `${describeStatus(lookup.status)}${lookup.detail ? `（${lookup.detail}）` : ''}`,
      })
      continue
    }

    const fields = mergeRecord(target.entry, { fields: lookup.fields })
    if (Object.keys(fields).length === 0) {
      skipped.push({ key: target.key, reason: `${lookup.source} 的记录里没有可补的字段（已有字段值一律不动）` })
      continue
    }
    filled.push({ key: target.key, fields, source: lookup.source, via: target.doi ? `doi:${target.doi}` : 'title' })
  }

  if (degradedStatuses.size > 0) {
    const what = [...degradedStatuses].map(describeStatus).join(' / ')
    messages.push(filled.length === 0 ? `${what}；本次没有任何字段被补全，本地文件未被改动` : `${what}；部分条目本次没能查到`)
  }
  if (filled.length === 0 && targets.length > 0 && degradedStatuses.size === 0) {
    messages.push('没有查到可补的字段。若条目本身已完整，这是正常结果')
  }
  if (targets.length === 0) messages.push('没有缺字段的条目，无需补全')

  const write = args.write === true
  let written = false
  let refused = null
  if (write) {
    if (filled.length === 0) {
      messages.push('write=true 但没有可写内容，文件未改动')
    } else {
      const result = applyFills(text, parsed, filled)
      // 红线 4 的后半句：写回前再解析一遍 + 逐字段核对，任何不一致就整体放弃
      const check = verifyFill(text, result.text, filled)
      if (!check.ok) {
        refused = `写入前自检失败：${check.reason}`
        messages.push(`${refused}；文件未改动`)
      } else {
        try {
          await writeAtomic(file, result.text)
          written = true
          await shared.logSafe('bib_fill', `filled ${filled.length} entr(ies) in ${shown}`)
        } catch (error) {
          refused = `写入失败：${fileErrorText(error)}`
        }
      }
    }
  }

  const value = {
    ok: true,
    path: shown,
    entries: parsed.entries.length,
    source,
    filled,
    skipped,
    written,
    messages,
    degraded: degradedStatuses.size > 0,
    pendingTargets: targets.length,
  }
  if (refused) value.refused = refused
  return value
}

/* ------------------------------------------------------------------ *
 * cite_audit
 * ------------------------------------------------------------------ */

const LIMITATIONS = [
  '% 注释行里的 \\cite 不计入（已按「奇数个反斜杠的 \\% 不算注释」处理）',
  'verbatim/lstlisting/minted 环境里的 \\cite 不计入（按环境配对抹除，嵌套写法可能漏）',
  '\\input / \\include 引出的子文件不会自动跟进，需要自己把它们加进 tex 数组',
  'biblatex 的复数形式（\\parencites、\\textcites 等多组 key）不解析',
  '\\nocite{*} 视为全库皆被引用，此时 neverCited 恒为空',
]

async function collectTexFiles(input, out) {
  const file = resolvePath(input)
  let info
  try {
    info = await stat(file)
  } catch (error) {
    out.push({ file, error: fileErrorText(error) })
    return
  }
  if (info.isDirectory()) {
    const entries = await readdir(file, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.tex')) continue
      out.push({ file: join(entry.parentPath ?? entry.path ?? file, entry.name) })
    }
    return
  }
  out.push({ file })
}

function renderAudit(value) {
  if (value.error) return `cite_audit 失败：${value.error}`
  const lines = []
  lines.push(`引用比对 · ${value.bib}`)
  lines.push(`${value.tex.length} 个 .tex · .bib 条目 ${value.totalEntries} 条 · 被引用 ${value.totalCited} 个 key`)
  if (value.noCiteAll) lines.push('检测到 \\nocite{*}：视为全库被引用')

  lines.push('')
  if (value.citedButMissing.length === 0) {
    lines.push('引用了但 .bib 里没有：无')
  } else {
    lines.push(`引用了但 .bib 里没有（${value.citedButMissing.length}）：`)
    for (const item of value.citedButMissing) {
      lines.push(`  - ${item.key}  ×${item.count}`)
      for (const location of item.locations) lines.push(`      ${location}`)
    }
  }

  lines.push('')
  if (value.neverCited.length === 0) {
    lines.push('从没被引用：无')
  } else {
    lines.push(`.bib 里有但从没被引用（${value.neverCited.length}）：`)
    for (const item of value.neverCited) lines.push(`  - ${item.key}  @${item.type} · 第 ${item.line} 行`)
  }

  if (value.notes.length > 0) {
    lines.push('')
    for (const note of value.notes) lines.push(`注意：${note}`)
  }
  if (value.limitations.length > 0) {
    lines.push('')
    lines.push('已知局限：')
    for (const limit of value.limitations) lines.push(`  - ${limit}`)
  }
  return lines.join('\n')
}

async function runAudit(args, shared) {
  const bibFile = resolvePath(args.bib)
  const shownBib = relativeToCwd(bibFile)
  let bibText
  try {
    bibText = await readText(bibFile)
  } catch (error) {
    return {
      ok: false, error: fileErrorText(error), bib: shownBib, tex: args.tex ?? [],
      totalEntries: 0, totalCited: 0, citedButMissing: [], neverCited: [],
      notes: [], limitations: LIMITATIONS, noCiteAll: false,
    }
  }

  const parsed = parseBib(bibText)
  const notes = []
  if (!parsed.ok) {
    notes.push(`.bib 没有完整解析（${parsed.errors[0]?.message ?? '未知原因'}），下面的结果只覆盖已解析出的 ${parsed.entries.length} 条`)
  }

  const inputs = []
  for (const item of args.tex ?? []) await collectTexFiles(item, inputs)

  const citations = []
  const warnings = []
  let noCiteAll = false
  const texShown = []
  for (const input of inputs) {
    if (input.error) {
      notes.push(`${relativeToCwd(input.file)}：${input.error}`)
      continue
    }
    let texText
    try {
      texText = await readText(input.file)
    } catch (error) {
      notes.push(`${relativeToCwd(input.file)}：${fileErrorText(error)}`)
      continue
    }
    const shown = relativeToCwd(input.file)
    texShown.push(shown)
    const extracted = extractCites(texText, shown)
    citations.push(...extracted.cites)
    warnings.push(...extracted.warnings)
    if (extracted.noCiteAll) noCiteAll = true
  }
  if (warnings.length > 0) notes.push(...warnings.slice(0, 10))

  const audit = auditCites({ citations, entries: parsed.entries, noCiteAll, warnings: [] })
  return {
    ok: parsed.ok && notes.length === 0,
    bib: shownBib,
    tex: texShown,
    totalEntries: audit.totalEntries,
    totalCited: audit.totalCited,
    citedButMissing: audit.citedButMissing,
    neverCited: audit.neverCited,
    noCiteAll: audit.noCiteAll,
    notes,
    limitations: LIMITATIONS,
    parseError: parsed.ok ? null : (parsed.errors[0]?.message ?? null),
  }
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../index.js').Shared} shared
 */
export function register(ctx, shared) {
  // 日志失败不能影响工具结果，统一包一层
  const logSafe = async (scope, message) => {
    try {
      await shared.log(scope, message)
    } catch {
      /* 日志是尽力而为 */
    }
  }
  const safeShared = { ...shared, logSafe }

  const bibLintTool = defineTool({
    name: 'bib_lint',
    description:
      '检查 .bib 文件：重复 key（带行号）、按条目类型检查必需字段、格式规范化（entry 类型/key/字段名大小写、字段顺序、多余空白）。纯文本处理，不需要 TeX 引擎。默认只报告不落盘。',
    parameters: {
      path: { type: 'string', required: true, description: '.bib 文件路径（绝对路径）' },
      write: { type: 'boolean', description: 'true 才把规范化结果写回文件；默认 false，只报告' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderLint(value) }],
    },
    execute: async (args) => withShared(safeShared, (shared) => runLint(args, shared)),
    timeoutMs: 30_000,
  })

  const bibFillTool = defineTool({
    name: 'bib_fill',
    description:
      '按 DOI（优先）或标题从 Crossref 补全 .bib 缺失字段。绝不覆盖已有字段值；写入前要求整个 .bib 能完整解析，解析失败则整体拒绝写。没网时优雅降级并说明来源不可达。默认只报告不落盘。',
    parameters: {
      path: { type: 'string', required: true, description: '.bib 文件路径（绝对路径）' },
      write: { type: 'boolean', description: 'true 才写回文件；默认 false，只报告会补哪些字段' },
      source: {
        type: 'string',
        enum: ['crossref', 'semantic-scholar'],
        description: '主数据源，默认 crossref；Crossref 查不到时才会用 Semantic Scholar',
      },
      limit: { type: 'integer', description: `本次最多查询多少条缺字段的条目，默认 ${DEFAULT_FILL_LIMIT}` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderFill(value) }],
    },
    execute: async (args, exec) => withShared(safeShared, (shared) => runFill(args, exec, shared)),
    timeoutMs: 180_000,
  })

  const citeAuditTool = defineTool({
    name: 'cite_audit',
    description:
      '比对 .tex 里的 \\cite 类命令与 .bib 条目：找出「引用了但 .bib 里没有」和「.bib 里有但从没被引用」。纯文本处理，不需要 TeX 引擎。',
    parameters: {
      bib: { type: 'string', required: true, description: '.bib 文件路径（绝对路径）' },
      tex: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '.tex 文件路径数组；给目录会递归收集其中的 .tex',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderAudit(value) }],
    },
    execute: async (args) => withShared(safeShared, (shared) => runAudit(args, shared)),
    timeoutMs: 60_000,
  })

  ctx.tools.register(bibLintTool)
  ctx.tools.register(bibFillTool)
  ctx.tools.register(citeAuditTool)

  safeShared.logSafe('bib', 'registered bib_lint, bib_fill, cite_audit')
}

/** 这三个工具都不许把异常甩给用户；兜底成结构化错误。 */
async function withShared(shared, run) {
  try {
    return await run(shared)
  } catch (error) {
    await shared.logSafe('bib', `uncaught: ${error?.stack ?? String(error)}`)
    return {
      ok: false,
      error: error?.message ?? String(error),
      filled: [],
      skipped: [],
      problems: [],
      fixed: [],
      citedButMissing: [],
      neverCited: [],
      written: false,
      messages: [],
      notes: [],
      limitations: [],
      entries: 0,
      totalEntries: 0,
      totalCited: 0,
    }
  }
}
