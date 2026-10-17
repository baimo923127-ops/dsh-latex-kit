/**
 * latex_doctor — report whether this machine can actually compile LaTeX.
 *
 * 诊断工具的价值全在「准」和「不抛异常」上：一台什么都没装的机器上，它必须
 * 正常返回一份「什么都没有、这样装」的报告，而不是让用户看见一个 ENOENT。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { inspectTectonic } from '../lib/tectonic.js'
import { probeEngines, selfTestCompile } from '../lib/tex.js'

/** 自检要启动真引擎；Tectonic 首次还要拉宏包索引，三分钟不够就太紧了。 */
const SELF_TEST_TIMEOUT_MS = 5 * 60_000

/**
 * 安装指引。
 *
 * `verified: false` 是有意为之：这台机器上没有任何 TeX，所以这些命令我没有
 * 跑通过。给命令仍然比给一句「请安装 LaTeX」有用，但不能假装验证过。
 */
const INSTALL_GUIDES = {
  tectonic: {
    what: '托管的 Tectonic（本插件自管，约 21MB，推荐）',
    windows: '在本会话里调用工具 latex_runtime install',
    note: '装到 %DSH_HOME%\\latex-kit\\runtime，不写系统 PATH、不需要管理员权限',
    verified: true,
  },
  texlive: {
    what: '完整 TeX Live（GB 级，latexmk/pdflatex/xelatex/biber 全都有）',
    windows: '下载并运行官方安装器 https://tug.org/texlive/windows.html 里的 install-tl-windows.exe',
    note: '插件不会自动安装它；也不要指望一次装完就有全量宏包（可后续 tlmgr install）',
    verified: false,
  },
  miktex: {
    what: 'MiKTeX（比 TeX Live 轻，按需装宏包）',
    windows: 'winget install MiKTeX.MiKTeX',
    note: '装完需要把 MiKTeX 的 bin 目录加进 PATH，并跑一次 miktex-console 允许自动装包',
    verified: false,
  },
  biber: {
    what: 'biber（biblatex 的文献后端）',
    windows: 'tlmgr install biber（TeX Live 自带，通常不必单独装）',
    note: 'Tectonic 内置的是 bibtex 而不是 biber，biblatex+biber 项目只能走 TeX Live',
    verified: false,
  },
  latexmk: {
    what: 'latexmk（多遍编译驱动）',
    windows: '随 TeX Live / MiKTeX 一起安装，不需要单独装',
    verified: false,
  },
}

function describeProbe(entry) {
  if (!entry || entry.present !== true) {
    return { present: false, path: null, version: null, banner: entry?.note ?? null }
  }
  return {
    present: true,
    path: entry.path ?? null,
    version: entry.version ?? null,
    banner: entry.banner ?? null,
  }
}

function renderProbe(label, probe) {
  if (!probe.present) return `  ✗ ${label}：没有`
  const version = probe.version ? `v${probe.version}` : '版本未知'
  return `  ✓ ${label}：${version}  ${probe.path ?? ''}`.trimEnd()
}

function renderDoctor(value) {
  const lines = []
  lines.push(value.ready ? '结论：这台机器现在能编译 LaTeX。' : '结论：这台机器现在还不能编译 LaTeX。')
  lines.push('')
  lines.push('引擎与工具：')
  lines.push(renderProbe('托管 Tectonic', value.tectonic.managed))
  lines.push(renderProbe('PATH 上的 tectonic', value.tectonic.path))
  lines.push(renderProbe('latexmk', value.drivers.latexmk))
  lines.push(renderProbe('pdflatex', value.engines.pdflatex))
  lines.push(renderProbe('xelatex', value.engines.xelatex))
  lines.push(renderProbe('lualatex', value.engines.lualatex))
  lines.push(renderProbe('biber', value.bibliography.biber))
  lines.push(renderProbe('bibtex', value.bibliography.bibtex))

  lines.push('')
  if (value.selfTest.skipped) {
    lines.push('最小编译自检：已跳过（selfTest: false）')
  } else if (value.selfTest.ok) {
    lines.push(`最小编译自检：通过——用 ${value.selfTest.engine} 生成了 ${value.selfTest.pages ?? '?'} 页 PDF（${value.selfTest.durationMs} ms）`)
    lines.push(`  ${value.selfTest.pdfPath}`)
  } else {
    lines.push(`最小编译自检：失败${value.selfTest.engine ? `（${value.selfTest.engine}）` : ''}`)
    if (value.selfTest.hint) lines.push(`  ${value.selfTest.hint}`)
    for (const error of value.selfTest.errors ?? []) {
      lines.push(`  ${error.file ?? '?'}:${error.line ?? '?'}  ${error.message}`)
    }
  }

  if (value.missing.length > 0) {
    lines.push('')
    lines.push('缺什么、怎么装（Windows）：')
    for (const item of value.missing) {
      lines.push(`  · ${item.label}`)
      if (item.guide) lines.push(`    ${item.guide}`)
    }
  }

  if (value.notes.length > 0) {
    lines.push('')
    for (const note of value.notes) lines.push(`注：${note}`)
  }
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../index.js').Shared} shared
 */
export function register(ctx, shared) {
  ctx.tools.register(defineTool({
    name: 'latex_doctor',
    description:
      '诊断这台机器能不能编译 LaTeX：逐个探测托管的与 PATH 上的 Tectonic、latexmk、'
      + 'pdflatex/xelatex/lualatex、biber/bibtex（都给出路径与版本），然后跑一次最小编译，'
      + '真的产出一个 PDF 才判定可用。缺失项只报告装法，绝不自动安装。',
    parameters: {
      selfTest: {
        type: 'boolean',
        description: '是否跑最小编译自检（默认 true）。关掉只探测不编译，更快但结论会弱一些',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderDoctor(value) }],
    },
    async execute(args, exec) {
      const runtime = await inspectTectonic()
      const engines = await probeEngines(shared)

      // 托管那一份以 inspectTectonic 为准（它带 manifest 与体积），
      // PATH 那一份以 probeEngines 为准（它带 where 出来的绝对路径）。
      const tectonic = {
        managed: {
          present: runtime.managed.available,
          path: runtime.managed.path,
          version: runtime.managed.version,
          banner: runtime.managed.available ? '插件托管，来源受控' : null,
        },
        // probeEngines 现在优先拿托管路径去探测 Tectonic，所以 engines.tectonic
        // 可能就是上面那一份。它已经计入 managed，不能再当成「PATH 上的」重复报一次。
        path: engines.tectonic?.managed === true
          ? { present: false, path: null, version: null, banner: null }
          : describeProbe(engines.tectonic),
      }
      const drivers = { latexmk: describeProbe(engines.latexmk) }
      const texEngines = {
        pdflatex: describeProbe(engines.pdflatex),
        xelatex: describeProbe(engines.xelatex),
        lualatex: describeProbe(engines.lualatex),
      }
      const bibliography = {
        biber: describeProbe(engines.biber),
        bibtex: describeProbe(engines.bibtex),
      }

      const hasEngine = tectonic.managed.present || tectonic.path.present || drivers.latexmk.present

      // ---- 自检 ---------------------------------------------------------
      const runSelfTest = args.selfTest !== false
      let selfTest
      if (!runSelfTest) {
        selfTest = { skipped: true, ok: false, engine: null, pdfPath: null, pages: null, durationMs: 0, errors: [], hint: null }
      } else if (!hasEngine) {
        // 没有引擎就别白跑一遍；这条提示比一个 ENOENT 有用得多。
        selfTest = {
          skipped: false,
          ok: false,
          engine: null,
          pdfPath: null,
          pages: null,
          durationMs: 0,
          errors: [],
          hint: '没有可用的引擎，最小编译自检没有可跑的东西。先运行 latex_runtime install。',
        }
      } else {
        try {
          selfTest = await selfTestCompile(shared, 'auto', {
            timeoutMs: SELF_TEST_TIMEOUT_MS,
            signal: exec.signal,
          })
          selfTest.skipped = false
        } catch (error) {
          selfTest = {
            skipped: false,
            ok: false,
            engine: null,
            pdfPath: null,
            pages: null,
            durationMs: 0,
            errors: [],
            hint: `自检本身崩了（不该发生）：${error?.message ?? error}`,
          }
        }
      }

      const ready = runSelfTest ? selfTest.ok === true : hasEngine

      // ---- 缺什么 -------------------------------------------------------
      const missing = []
      if (!tectonic.managed.present && !tectonic.path.present) {
        missing.push({
          id: 'tectonic',
          label: 'Tectonic（插件托管版，最省事）',
          guide: INSTALL_GUIDES.tectonic.windows,
          alternative: '或者安装完整 TeX Live / MiKTeX（见下）',
        })
      }
      if (!drivers.latexmk.present) {
        missing.push({
          id: 'latexmk',
          label: 'latexmk（编译需要 shell escape 的复杂项目时要它）',
          guide: INSTALL_GUIDES.latexmk.windows,
        })
      }
      if (!texEngines.pdflatex.present && !texEngines.xelatex.present && !texEngines.lualatex.present) {
        missing.push({
          id: 'texlive',
          label: 'TeX 引擎（pdflatex / xelatex / lualatex 全都没有）',
          guide: INSTALL_GUIDES.texlive.windows,
          alternative: INSTALL_GUIDES.miktex.windows,
        })
      }
      if (!bibliography.biber.present && !bibliography.bibtex.present) {
        missing.push({
          id: 'biber',
          label: '文献后端（biber / bibtex 都没有；Tectonic 内置 bibtex，所以只有它时仍可编引用）',
          guide: INSTALL_GUIDES.biber.windows,
        })
      }

      // ---- 备注 ---------------------------------------------------------
      const notes = []
      if (!runtime.managed.available && tectonic.path.present) {
        notes.push('PATH 上有 tectonic，插件会用它；但版本不受本插件控制，出问题时先想到这一点。')
      }
      if (runtime.managed.installed && !runtime.managed.available) {
        notes.push(`托管目录里有文件但跑不起来：${runtime.managed.path}。建议 latex_runtime remove 后重新 install。`)
      }
      if (!runSelfTest && hasEngine) {
        notes.push('这次跳过了最小编译自检，所以 ready 只是「看起来有引擎」，不代表真能出 PDF。')
      }

      return {
        ready,
        summary: ready
          ? `能编译。可用引擎：${[
              tectonic.managed.present ? `托管 Tectonic v${tectonic.managed.version ?? '?'}` : null,
              tectonic.path.present ? `PATH Tectonic v${tectonic.path.version ?? '?'}` : null,
              drivers.latexmk.present ? `latexmk v${drivers.latexmk.version ?? '?'}` : null,
            ].filter(Boolean).join('、')}`
          : hasEngine
            ? '有引擎但没有通过最小编译自检，详见 selfTest。'
            : '没有任何 LaTeX 引擎。运行 latex_runtime install 装托管的 Tectonic（约 21MB），或自己安装 TeX Live。',
        platform: `${process.platform}/${process.arch}`,
        tectonic,
        drivers,
        engines: texEngines,
        bibliography,
        selfTest,
        missing,
        installGuides: INSTALL_GUIDES,
        runtimeDirs: {
          runtime: runtime.runtimeDir,
          packages: runtime.packageCacheDir,
        },
        notes,
      }
    },
    timeoutMs: SELF_TEST_TIMEOUT_MS + 60_000,
  }))
}
