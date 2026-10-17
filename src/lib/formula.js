/**
 * latex_render 的纯逻辑层：剥包裹、算哈希、找引擎、归一化 SVG、自包含体检。
 *
 * 单独成模块的理由不只是「分层」：渲染引擎是可选的第三方包，而
 * `src/tools/render.js` 顶层必须 import `@deepseek-ai/dsh-tools`（宿主注入，
 * 本地磁盘上不存在），所以那一层在开发机上根本 import 不了。把逻辑放在这里，
 * 才能用 `node --input-type=module -e "import(...)"` 在没有宿主、没有渲染引擎
 * 的情况下真的跑一遍。
 *
 * 这一层只用 Node 内置模块，不依赖宿主，也不依赖任何第三方包。
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 我们唯一支持的引擎。实测 v4（`mathjax@4.1.3`）的 `tex-svg.js` 直接 import 会
 * 报 `Cannot find module '//sre/require.mjs'`——它是给打包器/exports 映射环境用
 * 的，Node 原生加载不通；v3 的 `js/` 目录是普通 CJS，动态 import 就能用。
 */
export const ENGINE_PACKAGE = 'mathjax-full'

/** 建议安装的版本：3.2.2 是 v3 最后一个版本，SVG 输出成熟。 */
export const ENGINE_VERSION = '3.2.2'

/**
 * 只装载这些 TeX 包。刻意**不含** `noundefined` 和 `noerrors`：
 * 它们会把未定义的宏、语法错误变成「红色文字」继续输出，那样 latex_render
 * 就会静默产出一张看似正常的废图，而用户要的是明确的失败。
 */
const TEX_PACKAGES = [
  { name: 'base', file: 'input/tex/base/BaseConfiguration.js' },
  { name: 'ams', file: 'input/tex/ams/AmsConfiguration.js' },
  { name: 'newcommand', file: 'input/tex/newcommand/NewcommandConfiguration.js' },
  { name: 'configmacros', file: 'input/tex/configmacros/ConfigMacrosConfiguration.js' },
  { name: 'color', file: 'input/tex/color/ColorConfiguration.js' },
  { name: 'boldsymbol', file: 'input/tex/boldsymbol/BoldsymbolConfiguration.js' },
  { name: 'mathtools', file: 'input/tex/mathtools/MathtoolsConfiguration.js' },
  { name: 'cancel', file: 'input/tex/cancel/CancelConfiguration.js' },
  { name: 'cases', file: 'input/tex/cases/CasesConfiguration.js' },
  { name: 'textmacros', file: 'input/tex/textmacros/TextMacrosConfiguration.js' },
  { name: 'enclose', file: 'input/tex/enclose/EncloseConfiguration.js' },
]

/** 1em 的像素数。SVG 的 viewBox 单位是 em/1000，用它换算成固定的 px 尺寸。 */
const EM_PX = 16

// ---------------------------------------------------------------------------
// 错误：工具层要能把「缺引擎」和「TeX 写错了」分开报，所以带 code
// ---------------------------------------------------------------------------

export class RenderError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'RenderError'
    this.code = code
    this.detail = detail
  }
}

/** 引擎找不到时抛这个；`detail` 里带装法，工具层原样转给用户。 */
export class EngineUnavailableError extends RenderError {
  constructor(message, detail = {}) {
    super('engine-unavailable', message, detail)
    this.name = 'EngineUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// 输入整形
// ---------------------------------------------------------------------------

/** `$…$`、`$$…$$`、`\[…\]`、`\(…\)`、`equation` 环境都剥掉，只留公式本体。 */
const WRAPPERS = [
  ['$$', '$$'],
  ['\\[', '\\]'],
  ['\\(', '\\)'],
  ['\\begin{equation*}', '\\end{equation*}'],
  ['\\begin{equation}', '\\end{equation}'],
  ['\\begin{displaymath}', '\\end{displaymath}'],
]

/**
 * 剥掉可能粘贴带进来的数学定界符。
 *
 * 剥之前要确认「首尾成对」，否则 `$a$ 和 $b$` 这种输入会被削成一个残句；
 * 单 `$` 还要额外拒绝内部出现 `$` 的情况，那是多段公式而不是一段。
 */
export function stripDelimiters(input) {
  let tex = String(input ?? '').trim()
  let changed = true
  while (changed && tex !== '') {
    changed = false
    for (const [open, close] of WRAPPERS) {
      if (tex.length > open.length + close.length && tex.startsWith(open) && tex.endsWith(close)) {
        tex = tex.slice(open.length, tex.length - close.length).trim()
        changed = true
      }
    }
    if (changed) continue
    if (tex.length > 2 && tex.startsWith('$') && tex.endsWith('$') && !tex.slice(1, -1).includes('$')) {
      tex = tex.slice(1, -1).trim()
      changed = true
    }
  }
  return tex
}

/** 内容哈希当文件名：同样的公式重复渲染落到同一个文件，不会堆一地垃圾。 */
export function contentHash(tex, display) {
  return createHash('sha256').update(`${display ? 'D' : 'I'}\u0000${tex}`, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 决定写到哪。相对路径按插件的 build 目录解析——运行时产物不许散落到用户工程里，
 * 要落进工程请给绝对路径。没有扩展名就补 `.svg`，给了别的扩展名直接拒绝：
 * 静默改成 .svg 会让用户以为自己的 `eq1.png` 真的成了 PNG。
 */
export function resolveOutPath(out, buildDir, hash) {
  const fallback = join(buildDir, `formula-${hash}.svg`)
  const raw = typeof out === 'string' ? out.trim() : ''
  if (raw === '') return { path: fallback, explicit: false }
  const target = isAbsolute(raw) ? raw : join(buildDir, raw)
  const ext = extname(target)
  if (ext === '') return { path: `${target}.svg`, explicit: true, addedExtension: true }
  if (ext.toLowerCase() !== '.svg') {
    throw new RenderError('unsupported-extension', `输出文件扩展名必须是 .svg（收到 ${ext}）；format 目前也只支持 svg`)
  }
  return { path: target, explicit: true }
}

// ---------------------------------------------------------------------------
// 引擎加载
// ---------------------------------------------------------------------------

/** 同一个 roots 只解析一次：30MB 的模块图重复加载会拖垮每次调用。 */
const engineCache = new Map()

/** 测试与「装完引擎后立刻重试」用；正常路径不需要。 */
export function forgetEngines() {
  engineCache.clear()
}

function tryResolve(roots, spec) {
  for (const root of roots) {
    try {
      return createRequire(join(root, '__dsh_latex_render.cjs')).resolve(spec)
    } catch { /* 这个 root 下没有，试下一个 */ }
  }
  // 最后退回本模块自身的解析链：用户把包装在插件包里时走这条。
  try {
    return createRequire(import.meta.url).resolve(spec)
  } catch {
    return null
  }
}

/**
 * 动态 import 一个 CJS 文件。
 *
 * `mathjax-full/js/*` 是 CommonJS（`require` + `exports`），用 file URL 走
 * 动态 import 才能拿到命名导出；`mod.default.x` 兜底是因为 cjs-module-lexer
 * 对某些文件识别不出命名导出。
 */
async function importCjs(file) {
  const mod = await import(pathToFileURL(file).href)
  return mod
}

function pick(mod, key) {
  if (mod && typeof mod[key] !== 'undefined') return mod[key]
  if (mod && mod.default && typeof mod.default[key] !== 'undefined') return mod.default[key]
  return undefined
}

/**
 * 按需启动渲染引擎。找不到就抛 EngineUnavailableError（带装法），绝不抛原生
 * MODULE_NOT_FOUND——工具层要拿它组织人话。
 *
 * @param {string[]} roots 先去这些目录的 node_modules 里找
 * @returns {Promise<{engine: object, warnings: string[]}>}
 */
export function loadEngine(roots = []) {
  const key = roots.join('|')
  if (!engineCache.has(key)) engineCache.set(key, bootEngine(roots))
  // 失败不缓存：用户装完引擎后同一次会话里重试就应该成。
  const pending = engineCache.get(key)
  pending.catch(() => engineCache.delete(key))
  return pending
}

async function bootEngine(roots) {
  const warnings = []
  const entry = tryResolve(roots, `${ENGINE_PACKAGE}/js/mathjax.js`)

  if (!entry) {
    throw new EngineUnavailableError(
      `找不到渲染引擎 ${ENGINE_PACKAGE}`,
      {
        package: ENGINE_PACKAGE,
        searched: roots,
        install: [
          `npm install --prefix "${roots[0] ?? '<kitHome>/engine'}" ${ENGINE_PACKAGE}@${ENGINE_VERSION}`,
        ],
      },
    )
  }

  const jsDir = dirname(entry)
  const pkgRoot = dirname(jsDir)

  let version = null
  try {
    version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? null
  } catch { /* 版本只是诊断信息，读不到不影响渲染 */ }

  let mathjax
  let TeX
  let SVG
  let liteAdaptor
  let RegisterHTMLHandler
  try {
    const [mjMod, texMod, svgMod, adaptorMod, htmlMod] = await Promise.all([
      importCjs(join(jsDir, 'mathjax.js')),
      importCjs(join(jsDir, 'input/tex.js')),
      importCjs(join(jsDir, 'output/svg.js')),
      importCjs(join(jsDir, 'adaptors/liteAdaptor.js')),
      importCjs(join(jsDir, 'handlers/html.js')),
    ])
    mathjax = pick(mjMod, 'mathjax')
    TeX = pick(texMod, 'TeX')
    SVG = pick(svgMod, 'SVG')
    liteAdaptor = pick(adaptorMod, 'liteAdaptor')
    RegisterHTMLHandler = pick(htmlMod, 'RegisterHTMLHandler')
  } catch (error) {
    throw new EngineUnavailableError(`渲染引擎加载失败：${error?.message ?? error}`, {
      package: ENGINE_PACKAGE,
      root: pkgRoot,
    })
  }

  if (!mathjax || !TeX || !SVG || !liteAdaptor || !RegisterHTMLHandler) {
    throw new EngineUnavailableError(
      `${ENGINE_PACKAGE} 的入口形状不对（缺 mathjax/TeX/SVG/liteAdaptor/RegisterHTMLHandler），可能是别的版本或别的包冒充`,
      { package: ENGINE_PACKAGE, root: pkgRoot, version },
    )
  }

  // TeX 包靠「require 配置模块」这个副作用注册到全局 handler；不 import 就永远
  // 报 Unknown environment。单独装载而不是走 AllPackages，是为了不把 34 个包
  // 全拉进来。缺某个包只丢这一个包，不让整次渲染失败。
  const req = createRequire(entry)
  const packages = []
  for (const pkg of TEX_PACKAGES) {
    try {
      req(`./${pkg.file}`)
      packages.push(pkg.name)
    } catch (error) {
      if (pkg.name === 'base') {
        throw new EngineUnavailableError(`TeX 基础包注册失败：${error?.message ?? error}`, {
          package: ENGINE_PACKAGE,
          root: pkgRoot,
          version,
        })
      }
      warnings.push(`TeX 包 ${pkg.name} 在本机这份 ${ENGINE_PACKAGE} 里装载失败，已跳过（相关命令不可用）`)
    }
  }

  const adaptor = liteAdaptor()
  RegisterHTMLHandler(adaptor)
  const tex = new TeX({ packages })
  // fontCache: 'local' → 字形 path 直接写进本文件的 <defs>；'none' 会重复内联，
  // 'global' 会放进共享的隐藏 svg（导出成单文件时那一半就丢了）。
  const svg = new SVG({ fontCache: 'local' })
  const document = mathjax.document('', { InputJax: tex, OutputJax: svg })

  return {
    engine: {
      name: ENGINE_PACKAGE,
      version,
      root: pkgRoot,
      packages,
      /** 返回 MathJax 的容器 HTML（mjx-container 里包着 svg），交给 toStandaloneSvg 整形。 */
      render(source, { display }) {
        const node = document.convert(source, {
          display,
          em: EM_PX,
          ex: EM_PX / 2,
          // 不换行：文件没有页宽约束，断成多行反而要再拼一层 svg。
          containerWidth: 1e6,
        })
        return adaptor.outerHTML(node)
      },
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 输出整形
// ---------------------------------------------------------------------------

const SVG_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n'

/**
 * 从 MathJax 的容器 HTML 里取出干净的独立 SVG 文件内容。
 *
 * 三处必须动：
 *   1. 容器 `<mjx-container>` 不是 SVG，去掉；根元素必须是 `<svg>`。
 *   2. MathJax 给的 width/height 是 `ex` 单位——`ex` 依赖父级字体，独立文件里
 *      没有父级，Word/Inkscape/LibreOffice 会把它当 0 或按 96dpi 猜。按
 *      viewBox（单位 em/1000）换算成 px 才是稳的。
 *   3. 字形用 `fill="currentColor"`，独立文件里没人给它继承色，补一个黑色。
 */
export function toStandaloneSvg(html) {
  const warnings = []
  const text = String(html ?? '')
  const start = text.indexOf('<svg')
  const end = text.lastIndexOf('</svg>')
  if (start < 0 || end <= start) {
    throw new RenderError('no-svg', '渲染器没有产出 svg 元素，输出无法当作矢量文件使用')
  }
  const blocks = text.match(/<svg[\s>]/g)
  if (blocks && blocks.length > 1) {
    warnings.push(`渲染结果包含 ${blocks.length} 个 svg 片段，已合并为同一个文件的连续内容；建议缩短公式`)
  }

  let svg = text.slice(start, end + '</svg>'.length)
  const tagEnd = svg.indexOf('>')
  const openTag = svg.slice(0, tagEnd)

  const viewBox = /viewBox="([^"]+)"/.exec(openTag)
  let sized = openTag.replace(/\s(?:width|height|style)="[^"]*"/g, '')
  if (!/\sxmlns="/.test(sized)) sized += ' xmlns="http://www.w3.org/2000/svg"'

  if (viewBox) {
    const box = viewBox[1].trim().split(/[\s,]+/).map(Number)
    if (box.length === 4 && box.every((n) => Number.isFinite(n)) && box[2] > 0 && box[3] > 0) {
      const px = (value) => Number(((value / 1000) * EM_PX).toFixed(2))
      sized += ` width="${px(box[2])}" height="${px(box[3])}"`
    }
  }
  if (!/viewBox="/.test(sized)) {
    warnings.push('渲染结果没有 viewBox，缩放会失真')
  }
  sized += ' style="color:#000"'

  svg = `${SVG_PROLOG}${sized}${svg.slice(tagEnd)}`
  return { svg, warnings }
}

/**
 * 自包含体检：产物里不许出现任何指向外部文件的引用。
 * 内部 `<use xlink:href="#id">` 指向同文件的 `<defs>`，那是允许的。
 */
const EXTERNAL_REF_RULES = [
  [/@font-face/, '@font-face 字体声明'],
  [/font-family/, 'font-family 字体族引用'],
  [/url\(\s*['"]?(?!#)/, 'url(...) 外部资源'],
  [/\.(?:woff2?|ttf|otf|eot)\b/i, '字体文件引用'],
  [/(?:xlink:)?href="(?!#)/, '指向外部文件的 href'],
  [/<image\b/, '<image> 内嵌位图'],
]

export function scanExternalRefs(svg) {
  const found = []
  for (const [pattern, label] of EXTERNAL_REF_RULES) {
    if (pattern.test(svg)) found.push(label)
  }
  return found
}

/** 从容器 HTML 里读 MathJax 的 TeX 错误；没有错误返回 null。 */
export function readTexError(html) {
  const match = /data-mjx-error="([^"]*)"/.exec(String(html ?? ''))
  if (!match) return null
  return decodeEntities(match[1])
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
