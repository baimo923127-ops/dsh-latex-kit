/**
 * Crossref（首选）与 Semantic Scholar（备选）的最小 HTTP 客户端。
 *
 * 只用 Node 内置 fetch：插件不引 axios/node-fetch，体积是硬要求。
 * 这里所有的失败都翻译成「状态」而不是抛异常——bib_fill 的契约是
 * 没网时优雅降级并说清原因，不是把异常糊到用户脸上。
 */

import { formatAuthorList, plainText } from './bibtex.js'

const CROSSREF_WORKS = 'https://api.crossref.org/works'
const S2_PAPER = 'https://api.semanticscholar.org/graph/v1/paper'
const DEFAULT_TIMEOUT_MS = 15_000

/** Crossref 的 polite pool：带上真实联系方式的 UA 会被优先服务。 */
function userAgent() {
  const mailto = (process.env.CROSSREF_MAILTO || '').trim()
  const base = 'dsh-latex-kit/0.1.0 (https://github.com/deepseek-ai/dsh-latex-kit)'
  return mailto ? `${base} mailto:${mailto}` : base
}

function mailtoSuffix(hasQuery) {
  const mailto = (process.env.CROSSREF_MAILTO || '').trim()
  if (!mailto) return ''
  return `${hasQuery ? '&' : '?'}mailto=${encodeURIComponent(mailto)}`
}

/** 每种状态一句中文，给 render 直接用。 */
const STATUS_TEXT = {
  ok: '查询成功',
  'not-found': '没有查到这条记录',
  'not-in-crossref': 'Crossref 没有这条记录',
  unreachable: 'Crossref 不可达（网络/DNS/代理问题）',
  timeout: 'Crossref 请求超时',
  cancelled: '请求被取消',
  'rate-limited': '请求被限流',
  'http-error': 'Crossref 返回了错误状态',
  ambiguous: '按标题查到的结果与条目标题对不上，已跳过',
  invalid: '缺少可用的 DOI 或标题',
}

export function describeStatus(status) {
  return STATUS_TEXT[status] ?? String(status)
}

async function getJson(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const signals = signal ? [signal, controller.signal] : [controller.signal]
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any(signals),
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      redirect: 'follow',
    })
    if (response.status === 404) return { status: 'not-found' }
    if (response.status === 429) return { status: 'rate-limited', detail: 'HTTP 429' }
    if (!response.ok) return { status: 'http-error', detail: `HTTP ${response.status}` }
    const body = await response.json()
    return { status: 'ok', body }
  } catch (error) {
    if (timedOut) return { status: 'timeout', detail: `超过 ${timeoutMs} ms` }
    if (signal?.aborted) return { status: 'cancelled' }
    // fetch 的网络失败一律是 TypeError('fetch failed')，真正的原因在 cause 里
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    return { status: 'unreachable', detail: String(cause) }
  } finally {
    clearTimeout(timer)
  }
}

function firstOf(value) {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined
  return value
}

function yearFrom(value) {
  // Crossref 的日期字段形状是 { 'date-parts': [[year, month, day]] }。
  // 旧实现把这个对象直接丢给数组解析，永远拿不到年份——真实响应里
  // issued 一定带日期，映射出来却没有 year，补出来的条目就缺年份。
  // 两种形状都认：对象取 date-parts，数组直接用。
  const nested = value && typeof value === 'object' && !Array.isArray(value)
    ? value['date-parts']
    : value
  const parts = firstOf(nested)
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  const year = Number(parts[0])
  return Number.isFinite(year) && year > 0 ? String(year) : undefined
}

/**
 * 把 Crossref 的 message 摊平成 BibTeX 字段。
 * container-title 到底算 journal 还是 booktitle，取决于目标条目类型——
 * 所以 entryType 必须传进来，否则会议论文会被填出一个假的 journal。
 */
export function mapCrossrefWork(message, entryType = 'article') {
  if (!message) return {}
  const isContainer = entryType === 'inproceedings' || entryType === 'conference' ||
    entryType === 'incollection' || entryType === 'inbook' || entryType === 'book'
  const container = plainText(firstOf(message['container-title']) ?? '').trim()
  const year = yearFrom(message.issued) ??
    yearFrom(message['published-print']) ??
    yearFrom(message['published-online']) ??
    yearFrom(message.published) ??
    yearFrom(message.created)

  const fields = {}
  const author = formatAuthorList(message.author)
  if (author) fields.author = author
  const editor = formatAuthorList(message.editor)
  if (editor) fields.editor = editor
  const title = plainText(firstOf(message.title) ?? '').trim()
  if (title) fields.title = title
  if (container) {
    if (isContainer) fields.booktitle = container
    else fields.journal = container
  }
  if (year) fields.year = year
  if (message.volume) fields.volume = String(firstOf(message.volume))
  if (message.issue) fields.number = String(firstOf(message.issue))
  if (message.page) fields.pages = String(message.page).replace(/\s*-\s*/, '--')
  if (message['article-number']) fields.eid = String(message['article-number'])
  if (message.publisher) fields.publisher = plainText(message.publisher).trim()
  if (message.DOI) fields.doi = String(message.DOI)
  if (message.URL) fields.url = String(message.URL)
  const issn = firstOf(message.ISSN)
  if (issn) fields.issn = String(issn)
  const isbn = firstOf(message.ISBN)
  if (isbn) fields.isbn = String(isbn)

  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''))
}

export async function lookupByDoiCrossref({ doi, entryType, signal, timeoutMs }) {
  const url = `${CROSSREF_WORKS}/${encodeURIComponent(doi)}${mailtoSuffix(false)}`
  const result = await getJson(url, { signal, timeoutMs })
  if (result.status !== 'ok') return { ok: false, source: 'crossref', status: result.status, detail: result.detail }
  const fields = mapCrossrefWork(result.body?.message, entryType)
  if (Object.keys(fields).length === 0) return { ok: false, source: 'crossref', status: 'not-found' }
  return { ok: true, source: 'crossref', status: 'ok', fields }
}

function titleTokens(value) {
  return plainText(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 2) // 停用词/短词没有判别力
}

/** 标题检索必须防「查错了那一篇」：token 重合度不够就当没查到。 */
export function titlesLookAlike(a, b) {
  const left = new Set(titleTokens(a))
  const right = new Set(titleTokens(b))
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const token of left) if (right.has(token)) shared++

  // 分母用较小集合时，「Deep learning for lung cancer diagnosis」和把 lung
  // 换成 breast 的标题能拿到 0.8——足以把另一篇论文的 DOI、作者、期刊
  // 一起补进来。补错的代价远高于少补，所以要求被查标题几乎被候选完整覆盖，
  // 且两个集合的并集重合也够高。
  const union = left.size + right.size - shared
  return shared / left.size >= 0.95 && shared / union >= 0.85
}

export async function lookupByTitleCrossref({ title, entryType, signal, timeoutMs }) {
  // 不加 select 参数：Crossref 对 select 里未列出的字段直接 400，稳妥优先
  const url = `${CROSSREF_WORKS}?query.bibliographic=${encodeURIComponent(title)}&rows=5${mailtoSuffix(true)}`
  const result = await getJson(url, { signal, timeoutMs })
  if (result.status !== 'ok') return { ok: false, source: 'crossref', status: result.status, detail: result.detail }
  const items = result.body?.message?.items
  if (!Array.isArray(items) || items.length === 0) return { ok: false, source: 'crossref', status: 'not-found' }
  const matches = items.filter((item) => titlesLookAlike(title, firstOf(item.title)))
  if (matches.length === 0) {
    return { ok: false, source: 'crossref', status: 'ambiguous', detail: `取了前 ${items.length} 条，标题都不够像` }
  }
  // 两条以上都像，说明这个标题定位不到唯一一篇（预印本/会议版/期刊版很常见），
  // 挑第一条就是在赌，宁可判 ambiguous 让人自己填。
  if (matches.length > 1) {
    return { ok: false, source: 'crossref', status: 'ambiguous', detail: `${matches.length} 条候选标题都像，无法确定是哪一篇` }
  }
  const match = matches[0]
  const fields = mapCrossrefWork(match, entryType)
  if (Object.keys(fields).length === 0) return { ok: false, source: 'crossref', status: 'not-found' }
  return { ok: true, source: 'crossref', status: 'ok', fields }
}

function mapSemanticScholar(paper, entryType) {
  if (!paper) return {}
  const isContainer = entryType === 'inproceedings' || entryType === 'conference' ||
    entryType === 'incollection' || entryType === 'inbook'
  const fields = {}
  const author = formatAuthorList((paper.authors ?? []).map((a) => a?.name))
  if (author) fields.author = author
  const title = plainText(paper.title ?? '').trim()
  if (title) fields.title = title
  const venue = plainText(paper.journal?.name ?? paper.venue ?? '').trim()
  if (venue) {
    if (isContainer) fields.booktitle = venue
    else fields.journal = venue
  }
  if (paper.year) fields.year = String(paper.year)
  if (paper.externalIds?.DOI) fields.doi = String(paper.externalIds.DOI)
  if (paper.externalIds?.ArXiv) fields.eprint = String(paper.externalIds.ArXiv)
  return fields
}

export async function lookupSemanticScholar({ doi, title, entryType, signal, timeoutMs }) {
  const fieldsQuery = 'title,authors,year,venue,journal,externalIds'
  const url = doi
    ? `${S2_PAPER}/DOI:${encodeURIComponent(doi)}?fields=${fieldsQuery}`
    : `${S2_PAPER}/search?query=${encodeURIComponent(title ?? '')}&limit=1&fields=${fieldsQuery}`
  const result = await getJson(url, { signal, timeoutMs })
  if (result.status !== 'ok') return { ok: false, source: 'semantic-scholar', status: result.status, detail: result.detail }
  const paper = doi ? result.body : result.body?.data?.[0]
  if (!paper) return { ok: false, source: 'semantic-scholar', status: 'not-found' }
  if (!doi && title && !titlesLookAlike(title, paper.title)) {
    return { ok: false, source: 'semantic-scholar', status: 'ambiguous' }
  }
  const fields = mapSemanticScholar(paper, entryType)
  if (Object.keys(fields).length === 0) return { ok: false, source: 'semantic-scholar', status: 'not-found' }
  return { ok: true, source: 'semantic-scholar', status: 'ok', fields }
}

/**
 * 一个条目的完整查询：DOI 优先，其次标题；Crossref 查不到才用 Semantic Scholar。
 * 返回的 source 记录真实生效的来源，绝不谎报。
 */
export async function lookupEntry({ doi, title, entryType, source = 'crossref', signal, timeoutMs }) {
  if (!doi && !title) {
    return { ok: false, source: null, status: 'invalid', attempts: [] }
  }

  const attempts = []
  if (source === 'crossref') {
    const first = doi
      ? await lookupByDoiCrossref({ doi, entryType, signal, timeoutMs })
      : await lookupByTitleCrossref({ title, entryType, signal, timeoutMs })
    attempts.push({ source: 'crossref', via: doi ? 'doi' : 'title', status: first.status, detail: first.detail })
    if (first.ok) return { ...first, attempts }

    // ambiguous 是「查到了，但定位不到唯一一篇」。换一个库只是换一种赌法：
    // Semantic Scholar 会自信地返回其中一条，等于把 Crossref 刚拦下的误配
    // 从后门放回来。只有「这个来源根本没给出数据」才值得换来源重试。
    if (first.status === 'ambiguous') {
      return { ok: false, source: 'crossref', status: 'ambiguous', detail: first.detail, attempts }
    }

    // Crossref 不可达/超时的时候，第二来源其实也大概率不通，但仍试一次——
    // 它通不通都不该让整个工具失败，因此这里不做任何抛错。
    const fallback = await lookupSemanticScholar({ doi, title, entryType, signal, timeoutMs })
    attempts.push({ source: 'semantic-scholar', via: doi ? 'doi' : 'title', status: fallback.status, detail: fallback.detail })
    if (fallback.ok) return { ...fallback, attempts }
    // 主因报 Crossref 的状态：用户要理解的是第一来源怎么了
    return { ok: false, source: 'crossref', status: first.status, detail: first.detail, attempts }
  }

  const s2 = await lookupSemanticScholar({ doi, title, entryType, signal, timeoutMs })
  attempts.push({ source: 'semantic-scholar', via: doi ? 'doi' : 'title', status: s2.status, detail: s2.detail })
  if (s2.ok) return { ...s2, attempts }
  return { ok: false, source: 'semantic-scholar', status: s2.status, detail: s2.detail, attempts }
}
