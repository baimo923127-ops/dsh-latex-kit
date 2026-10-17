/**
 * TeX log parsing, engine discovery and compile orchestration.
 *
 * 所有可测的逻辑都放在这里，`src/tools/*.js` 只做 defineTool 包装——因为
 * `@deepseek-ai/dsh-tools` 由宿主注入（本地 node_modules 解析不到，这是正常
 * 的），工具文件无法直接 import 单测，而这个文件可以。
 */

import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'

import { buildDir, packageCacheDir } from './paths.js'
import { isMissingBinary } from './process.js'

// ---------------------------------------------------------------------------
// 引擎清单
// ---------------------------------------------------------------------------

/**
 * 探测顺序刻意把 tectonic 放最前：它是本插件能自足提供的那一个，
 * 其余全靠用户自己装，报告里要让人一眼看出「哪个是我们管的」。
 */
const ENGINE_PROBES = [
  { id: 'tectonic', args: ['--version'], role: 'engine' },
  { id: 'latexmk', args: ['-v'], role: 'driver' },
  { id: 'pdflatex', args: ['--version'], role: 'engine' },
  { id: 'xelatex', args: ['--version'], role: 'engine' },
  { id: 'lualatex', args: ['--version'], role: 'engine' },
  { id: 'biber', args: ['--version'], role: 'bibliography' },
  { id: 'bibtex', args: ['--version'], role: 'bibliography' },
]

/** 从任意版本输出里捞第一个像版本号的 token；各引擎格式不一，统一对付。 */
function pickVersion(text) {
  const match = /\bv?(\d+\.\d+[\w.+-]*)/.exec(text ?? '')
  return match ? match[1] : null
}

/** 取第一条非空行作为「这是哪个程序」的判据，避免把整段 help 塞进报告。 */
function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/).find((item) => item.trim() !== '')
  return line ? line.trim() : ''
}

/** where/which 拿绝对路径；拿不到就退回裸名字（spawn 仍能靠 PATH 解析）。 */
async function locateBinary(shared, name) {
  const which = await shared.run(process.platform === 'win32' ? 'where' : 'which', [name], { timeoutMs: 10_000 })
  if (which.code === 0) {
    const first = which.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
    if (first) return first
  }
  return null
}

/**
 * 探测一台机器上的 TeX 相关程序。
 * 缺失不是错误——这正是 doctor 要如实报告的内容。
 */
export async function probeEngines(shared) {
  // 托管的那份不在 PATH 上，按名字探测会漏掉它——而它恰恰是本插件最主要的能力来源。
  const managed = await Promise.resolve()
    .then(() => shared.resolveTectonic?.())
    .catch(() => null)

  const results = {}
  await Promise.all(
    ENGINE_PROBES.map(async (probe) => {
      const useManaged = probe.id === 'tectonic' && managed?.managed === true
      const outcome = await shared.run(useManaged ? managed.path : probe.id, probe.args, { timeoutMs: 20_000 })
      if (isMissingBinary(outcome) || (outcome.spawnError && outcome.code === null)) {
        results[probe.id] = { present: false, path: null, version: null, role: probe.role }
        return
      }
      if (outcome.code !== 0) {
        results[probe.id] = { present: false, path: null, version: null, role: probe.role, note: `退出码 ${outcome.code}` }
        return
      }
      const text = `${outcome.stdout}\n${outcome.stderr}`
      results[probe.id] = {
        present: true,
        path: useManaged ? managed.path : await locateBinary(shared, probe.id),
        ...(useManaged ? { managed: true } : {}),
        version: pickVersion(text),
        banner: firstLine(text),
        role: probe.role,
      }
    }),
  )
  return results
}

// ---------------------------------------------------------------------------
// TeX 日志解析
// ---------------------------------------------------------------------------

/** 日志可能上兆；解析只为了错误定位，超长部分从尾部截断（尾部才是结论）。 */
const MAX_LOG_CHARS = 4 * 1024 * 1024

/**
 * 跟踪 TeX 日志的 `(file …)` 括号栈，给每个 `!` 错误定位「当时在编哪个文件」。
 *
 * 为什么不用正则匹配整份日志：TeX 日志里括号会嵌套到几十层（每层一个宏包），
 * 只有栈能还原「错误发生时的编译单元」。`(` 后面不是文件名的（`[1]`、尺寸之类）
 * 压入 null 占位，保证弹栈时不会错位。
 */
function scanErrorFiles(text) {
  const stack = []
  const marks = new Map()
  let index = 0
  const isBoundary = (char) => char === undefined || /[\s()[\]{}]/.test(char)

  while (index < text.length) {
    const char = text[index]
    if (char === '(') {
      let cursor = index + 1
      while (cursor < text.length && !isBoundary(text[cursor])) cursor += 1
      const token = text.slice(index + 1, cursor)
      const looksLikeFile = token !== '' && (/[\\/:]/.test(token) || /\.[A-Za-z0-9]{1,6}$/.test(token))
      stack.push(looksLikeFile ? token : null)
      index = cursor
      continue
    }
    if (char === ')') {
      stack.pop()
      index += 1
      continue
    }
    if (char === '!' && isBoundary(text[index - 1])) {
      const nearest = [...stack].reverse().find((item) => typeof item === 'string')
      marks.set(index, nearest ?? null)
    }
    index += 1
  }
  return marks
}

/**
 * 解析 TeX 日志。
 *
 * 输出形状是 `latex_compile` 报告的一部分，所以这里返回的键名就是工具输出契约。
 */
export function parseLatexLog(rawText, options = {}) {
  const { maxWarnings = 5, maxErrors = 25 } = options
  let text = String(rawText ?? '')
  if (text.length > MAX_LOG_CHARS) text = text.slice(-MAX_LOG_CHARS)

  const fileMarks = scanErrorFiles(text)

  // 逐行累计偏移，才能把「第 N 行」映射回括号栈快照里的字符位置。
  // 不能 split(/\r?\n/) 之后按 +1 累加：CRLF 日志的换行占两个字符，
  // 那样每行会少算一个，误差逐行累积，最终位置和括号栈快照对不上，
  // 错误就丢了文件名。这里按真实换行位置切，偏移量才和原文一致。
  const lines = []
  const lineOffsets = []
  let cursor = 0
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor)
    const end = newline === -1 ? text.length : newline
    lineOffsets.push(cursor)
    lines.push(text.slice(cursor, end).replace(/\r$/, ''))
    if (newline === -1) break
    cursor = newline + 1
  }

  const fileAt = (lineIndex) => {
    const target = lineOffsets[lineIndex] ?? 0
    let best = null
    let bestIndex = -1
    for (const [position, file] of fileMarks) {
      if (position <= target && position > bestIndex) {
        bestIndex = position
        best = file
      }
    }
    return best
  }

  const errors = []
  const warningSamples = []
  let warningCount = 0
  const undefinedRefs = []
  const undefinedCitations = []
  let overfull = 0
  let pages = null
  let outputFile = null
  let rerunSuggested = false

  const WARNING_LINE = /^(?:LaTeX|LaTeX Font|Class \S+|Package \S+|Module \S+)\s+Warning:/
  const REF_UNDEFINED = /Reference `([^']*)' on page (\S+) undefined on input line (\d+)/
  const CITATION_UNDEFINED = /Citation `([^']*)' on page (\S+) undefined on input line (\d+)/
  const OUTPUT_WRITTEN = /Output written on (.+?) \((\d+) pages?, \d+ bytes\)/

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    // ---- 错误块 ---------------------------------------------------------
    if (line.startsWith('!')) {
      const messageParts = [line.slice(1).trim()]
      let errorLine = null
      let cursor = index + 1
      let scanned = 0
      let blankSeen = false
      // 一条错误的正文在下一个 `l.NN` 之前。注意 TeX 常在错误头后面插一个空行
      // （`! LaTeX Error: File ... not found.` 就是这样），空行不是错误结束，
      // 放过去继续找 `l.NN`，否则最需要行号的那类错误反而拿不到行号。
      while (cursor < lines.length && scanned < 40) {
        const current = lines[cursor]
        const lineMatch = /^l\.(\d+)/.exec(current)
        if (lineMatch) {
          errorLine = Number(lineMatch[1])
          break
        }
        if (current.startsWith('!')) break
        if (/^Output written on|^No pages of output/.test(current)) break
        if (current.trim() === '') {
          blankSeen = true
          cursor += 1
          scanned += 1
          continue
        }
        // 空行之后的是 TeX 的解释性文字（Type X to quit…），不算错误本体的消息。
        if (!blankSeen) messageParts.push(current.trim())
        cursor += 1
        scanned += 1
      }
      if (errors.length < maxErrors) {
        errors.push({
          file: fileAt(index),
          line: errorLine,
          message: messageParts.filter((part) => part !== '').join(' ').slice(0, 1200),
        })
      }
      index = cursor - 1
      continue
    }

    // ---- 警告 -----------------------------------------------------------
    if (WARNING_LINE.test(line)) {
      warningCount += 1
      if (warningSamples.length < maxWarnings) {
        warningSamples.push({
          file: fileAt(index),
          message: line.trim().slice(0, 600),
        })
      }
      const ref = REF_UNDEFINED.exec(line)
      if (ref) undefinedRefs.push({ name: ref[1], page: ref[2], line: Number(ref[3]), file: fileAt(index) })
      const citation = CITATION_UNDEFINED.exec(line)
      if (citation) {
        undefinedCitations.push({ name: citation[1], page: citation[2], line: Number(citation[3]), file: fileAt(index) })
      }
      continue
    }

    // ---- 统计 -----------------------------------------------------------
    if (/^Overfull \\[hv]box/.test(line)) {
      overfull += 1
      continue
    }
    if (/^Underfull \\[hv]box/.test(line)) {
      warningCount += 1
      continue
    }
    if (line.includes('Rerun to get') || line.includes('Label(s) may have changed')) {
      rerunSuggested = true
      continue
    }
    const written = OUTPUT_WRITTEN.exec(line)
    if (written) {
      outputFile = written[1].trim()
      pages = Number(written[2])
    }
  }

  // TeX 最后会补一句「There were undefined references」，这句话本身不是错误，
  // 但它意味着引用确实没解析出来，所以要反映进计数。
  if (/There were undefined references/.test(text)) rerunSuggested = true
  if (/There were undefined citations/.test(text)) rerunSuggested = true

  return {
    errors,
    warnings: { count: warningCount, samples: warningSamples },
    undefinedRefs,
    undefinedCitations,
    overfull,
    pages,
    outputFile,
    rerunSuggested,
  }
}

/**
 * 从 PDF 字节里数页数：日志拿不到页数时的兜底。
 * 只数 `/Type /Page`，不数 `/Type /Pages`（那是页树节点，一个就够）。
 */
export function countPdfPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  const text = buffer.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page(?![s])/g)
  return matches ? matches.length : null
}

// ---------------------------------------------------------------------------
// 引擎选择
// ---------------------------------------------------------------------------

/**
 * 「这个项目只有完整 TeX Live 能编」的静态信号。
 *
 * 依据是 Tectonic 与 TeX Live 的真实能力差，不是偏好：
 *   - Tectonic 不执行 shell escape（`\write18`），minted / svg / shellesc 类宏包
 *     依赖外部程序，跑到 Tectonic 上会直接失败；
 *   - Tectonic 内置 bibtex，但不跑 biber，biblatex+biber 的组合它做不了；
 *   - pstricks 依赖 PostScript 后处理，Tectonic 没有那条路；
 *   - 项目自带 latexmkrc 意味着作者显式声明了构建流程，绕过它是不尊重。
 * 命中任意一条就优先 latexmk；没命中就交给 Tectonic（它自己会按需拉宏包）。
 */
const FULL_TEXLIVE_SIGNALS = [
  { pattern: /\\usepackage(?:\[[^\]]*\])?\{minted\}/, reason: 'minted 需要 shell escape，Tectonic 不支持' },
  { pattern: /\\(?:immediate\s*)?write18\b/, reason: '\\write18 需要 shell escape，Tectonic 不支持' },
  { pattern: /\\usepackage(?:\[[^\]]*\])?\{shellesc\}/, reason: 'shellesc 需要 shell escape，Tectonic 不支持' },
  { pattern: /\\usepackage(?:\[[^\]]*\])?\{svg\}/, reason: 'svg 宏包需要外部 inkscape（shell escape）' },
  { pattern: /\\usepackage(?:\[[^\]]*\])?\{pstricks\}/, reason: 'pstricks 需要 PostScript 后处理，Tectonic 没有' },
  { pattern: /backend\s*=\s*biber/i, reason: 'biblatex 的 biber 后端，Tectonic 内置的是 bibtex' },
  { pattern: /\\usepackage(?:\[[^\]]*\])?\{(?:biblatex|natbib)\}[\s\S]{0,400}?\\addbibresource/, reason: '' },
]

/** 返回 `[{ reason }]`；空数组表示「Tectonic 应该能编」。 */
export function detectFullTexLiveSignals(sourceText, projectFiles = []) {
  const reasons = []
  const text = String(sourceText ?? '')
  for (const signal of FULL_TEXLIVE_SIGNALS) {
    if (signal.pattern.test(text) && signal.reason !== '') reasons.push(signal.reason)
  }
  for (const name of projectFiles) {
    if (/(^|[\\/])\.?latexmkrc$/i.test(name)) {
      reasons.push(`项目自带 ${basename(name)}，作者显式声明了 latexmk 构建流程`)
    }
  }
  return [...new Set(reasons)]
}

/**
 * 决定用哪个引擎。
 *
 * 用户显式指定就照做，绝不偷偷换——换引擎会改变排版结果，那必须由人决定。
 * `auto` 的取舍写在 detectFullTexLiveSignals 的注释里。
 */
export function chooseEngine(requested, { tectonic, latexmk, fullTexLiveReasons }) {
  if (requested === 'tectonic') {
    return tectonic
      ? { engine: 'tectonic', reason: '按你的要求使用 Tectonic' }
      : { engine: null, reason: '你指定了 Tectonic，但这台机器上没有可用的 Tectonic，请先运行 latex_runtime install' }
  }
  if (requested === 'latexmk') {
    return latexmk
      ? { engine: 'latexmk', reason: '按你的要求使用 latexmk（需要完整 TeX Live）' }
      : { engine: null, reason: '你指定了 latexmk，但这台机器的 PATH 上找不到 latexmk，需要先安装 TeX Live' }
  }

  if (fullTexLiveReasons.length > 0 && latexmk) {
    return { engine: 'latexmk', reason: `项目需要完整 TeX Live：${fullTexLiveReasons.join('；')}` }
  }
  if (tectonic) {
    const suffix = fullTexLiveReasons.length > 0 ? `（虽然检测到 ${fullTexLiveReasons[0]}，但本机没有 latexmk，只能用 Tectonic 试）` : ''
    return { engine: 'tectonic', reason: `Tectonic 可用且项目没有要求 TeX Live 专属特性${suffix}` }
  }
  if (latexmk) {
    return { engine: 'latexmk', reason: '没有 Tectonic，回落到系统上的 latexmk' }
  }
  return {
    engine: null,
    reason: '这台机器上找不到任何可用的 LaTeX 引擎：先运行 latex_runtime install 装托管的 Tectonic（推荐，约 21MB），或者自己安装 TeX Live',
  }
}

// ---------------------------------------------------------------------------
// 编译
// ---------------------------------------------------------------------------

function makeRunDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(buildDir(), `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`)
}

/** 把日志尾部截出来；整份 TeX 日志没人读得下去，尾部才是结论所在。 */
function tailOf(text, maxChars = 4000) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  return `…（已省略前 ${value.length - maxChars} 字符）…\n${value.slice(-maxChars)}`
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** 同目录里有哪些文件——只用来识别 latexmkrc 这类项目级构建声明。 */
async function listProjectFiles(dir) {
  try {
    const items = await readdir(dir, { withFileTypes: true })
    return items.filter((item) => item.isFile()).map((item) => item.name)
  } catch {
    return []
  }
}

/**
 * 跑一次真编译。
 *
 * 产物去向（AGENTS.md 第 3 节）：所有中间文件留在 `$DSH_HOME/latex-kit/build/<run>`，
 * 只有 PDF 复制回工程目录，和入口 `.tex` 并排——用户看的是 PDF，中间文件不该
 * 污染他的仓库。
 */
export async function compileProject(shared, options) {
  const started = Date.now()
  const {
    entryPath,
    engine: requestedEngine = 'auto',
    timeoutMs = 180_000,
    signal,
  } = options

  const entryAbs = resolvePath(entryPath)
  const report = {
    ok: false,
    engine: null,
    engineRequested: requestedEngine,
    engineReason: null,
    pdfPath: null,
    outputDir: null,
    buildDir: null,
    errors: [],
    warnings: { count: 0, samples: [] },
    undefinedRefs: { count: 0, items: [] },
    undefinedCitations: { count: 0, items: [] },
    overfull: 0,
    pages: null,
    rerunSuggested: false,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    logTail: null,
    hint: null,
  }

  // ---- 入口检查 ---------------------------------------------------------
  if (extname(entryAbs).toLowerCase() !== '.tex') {
    report.hint = `入口文件必须是 .tex，收到的是 ${basename(entryAbs)}`
    report.durationMs = Date.now() - started
    return report
  }
  if (!(await fileExists(entryAbs))) {
    report.hint = `找不到入口文件：${entryAbs}`
    report.durationMs = Date.now() - started
    return report
  }

  const projectDir = dirname(entryAbs)
  let sourceText = ''
  try {
    sourceText = await readFile(entryAbs, 'utf8')
  } catch (error) {
    report.hint = `入口文件读不了：${error?.message ?? error}`
    report.durationMs = Date.now() - started
    return report
  }

  // ---- 选引擎 -----------------------------------------------------------
  const engines = await probeEngines(shared)
  const fullTexLiveReasons = detectFullTexLiveSignals(sourceText, await listProjectFiles(projectDir))
  const choice = chooseEngine(requestedEngine, {
    tectonic: engines.tectonic?.present ? engines.tectonic : null,
    latexmk: engines.latexmk?.present ? engines.latexmk : null,
    fullTexLiveReasons,
  })
  report.engineReason = choice.reason

  if (!choice.engine) {
    report.hint = choice.reason
    report.durationMs = Date.now() - started
    return report
  }
  report.engine = choice.engine

  // ---- 准备构建目录 -----------------------------------------------------
  const runDir = makeRunDir()
  report.buildDir = runDir
  try {
    await mkdir(runDir, { recursive: true })
  } catch (error) {
    report.hint = `无法创建构建目录 ${runDir}：${error?.message ?? error}`
    report.durationMs = Date.now() - started
    return report
  }

  const jobName = basename(entryAbs, extname(entryAbs))

  // ---- 执行 -------------------------------------------------------------
  let outcome
  if (choice.engine === 'tectonic') {
    const binary = engines.tectonic?.path ?? 'tectonic'
    // --keep-logs 才留 .log（否则 Tectonic 只在失败时往 stderr 打片段）。
    // Tectonic 0.17 没有 --cache-dir 参数（传了会直接失败）；宏包缓存的真实开关是
    // 环境变量 TECTONIC_CACHE_DIR。不设它 Tectonic 会往 %LOCALAPPDATA% 写，违反
    // 「产物只落在 $DSH_HOME/latex-kit 下」。
    outcome = await shared.run(
      binary,
      [entryAbs, '--outdir', runDir, '--keep-logs'],
      { cwd: projectDir, timeoutMs, signal, env: { ...process.env, TECTONIC_CACHE_DIR: packageCacheDir() } },
    )
  } else {
    const binary = engines.latexmk?.path ?? 'latexmk'
    // -outdir 把 aux/log/pdf 全推到构建目录，工程目录保持干净；
    // -halt-on-error 让错误立刻停，避免用一堆级联错误埋掉第一个真错误。
    outcome = await shared.run(
      binary,
      ['-pdf', '-interaction=nonstopmode', '-halt-on-error', `-outdir=${runDir}`, entryAbs],
      { cwd: projectDir, timeoutMs, signal },
    )
  }

  report.exitCode = outcome.code
  report.timedOut = outcome.timedOut
  report.durationMs = outcome.durationMs

  if (outcome.spawnError !== null) {
    report.hint = `启动 ${choice.engine} 失败：${outcome.spawnError}`
    report.durationMs = Date.now() - started
    return report
  }

  // ---- 解析日志 ---------------------------------------------------------
  const logPath = join(runDir, `${jobName}.log`)
  let logText = ''
  if (await fileExists(logPath)) {
    logText = await readFile(logPath, 'utf8').catch(() => '')
  }
  if (logText.trim() === '') {
    // 没有 .log（多数是启动阶段就失败了），就把 Tectonic 的 stderr 当日志解析。
    logText = `${outcome.stdout}\n${outcome.stderr}`
  }

  const parsed = parseLatexLog(logText)
  report.errors = parsed.errors
  report.warnings = parsed.warnings
  report.undefinedRefs = { count: parsed.undefinedRefs.length, items: parsed.undefinedRefs.slice(0, 10) }
  report.undefinedCitations = { count: parsed.undefinedCitations.length, items: parsed.undefinedCitations.slice(0, 10) }
  report.overfull = parsed.overfull
  report.rerunSuggested = parsed.rerunSuggested

  // ---- 收 PDF -----------------------------------------------------------
  const producedPdf = join(runDir, `${jobName}.pdf`)
  const success = outcome.code === 0 && (await fileExists(producedPdf))

  if (success) {
    const destination = join(projectDir, `${jobName}.pdf`)
    try {
      await copyFile(producedPdf, destination)
      report.pdfPath = destination
      report.outputDir = projectDir
      report.ok = true
    } catch (error) {
      report.hint = `PDF 已生成但复制回工程目录失败：${error?.message ?? error}`
      report.pdfPath = producedPdf
    }
    report.pages = parsed.pages
    if (report.pages === null) {
      const buffer = await readFile(producedPdf).catch(() => null)
      report.pages = buffer ? countPdfPages(buffer) : null
    }
  } else {
    report.pages = parsed.pages
    if (report.errors.length === 0) {
      report.logTail = tailOf(logText)
      if (report.hint === null) {
        report.hint = outcome.timedOut
          ? `编译超时（${Math.round(timeoutMs / 1000)} 秒）后被杀掉。可以调大 timeoutMs，或检查项目里是否有需要交互的地方。`
          : `引擎以退出码 ${outcome.code} 结束，且日志里没有可定位的错误；请看 logTail。`
      }
    } else if (report.hint === null) {
      report.hint = `编译失败，共 ${report.errors.length} 处错误。`
    }
  }

  if (report.ok && report.errors.length > 0) {
    // 出了 PDF 但有错误：给出 PDF 也如实报错误，别让人以为干净通过。
    report.hint ??= `生成了 PDF，但日志里仍有 ${report.errors.length} 处错误。`
  }

  report.durationMs = Date.now() - started
  return report
}

/**
 * doctor 的最小编译自检：声称「能编译」必须拿一个真 PDF 出来，否则只是在
 * 报告「文件存在」——这两件事在这台机器上差得很远。
 *
 * 复用 compileProject 而不是另写一条编译路径，是为了让自检走的就是用户
 * 实际会走的那条路；自检通过而真编译失败是最难解释的一种 bug。
 * 整个过程发生在 build 目录里，不碰任何用户工程。
 */
export async function selfTestCompile(shared, requestedEngine, { timeoutMs = 120_000, signal } = {}) {
  const runDir = makeRunDir()
  await mkdir(runDir, { recursive: true })
  const sourcePath = join(runDir, 'dsh-latex-kit-selftest.tex')
  const source = [
    '\\documentclass{article}',
    '\\begin{document}',
    'dsh-latex-kit doctor self-test',
    '\\end{document}',
    '',
  ].join('\n')
  await writeFile(sourcePath, source, 'utf8')

  const report = await compileProject(shared, { entryPath: sourcePath, engine: requestedEngine, timeoutMs, signal })
  return {
    ok: report.ok,
    engine: report.engine,
    engineReason: report.engineReason,
    pdfPath: report.pdfPath,
    pages: report.pages,
    durationMs: report.durationMs,
    errors: report.errors,
    hint: report.hint,
    logTail: report.logTail,
  }
}
