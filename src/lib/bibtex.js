/**
 * BibTeX 文本层：解析、体检、规范化、补全、引用比对。
 *
 * 为什么自己写解析器，而不是引第三方包：
 *   1. `bib_fill` 只能「插入」不能重建全文——重建会丢注释和文件尾部（产品红线 4）。
 *      要做到这点，必须知道每个字段在原文里的字符偏移量；现成解析器只交语义树。
 *   2. 体积与可控性：整套逻辑约 700 行，无依赖，任何机器上 import 就能跑。
 *
 * 解析器的失败策略是「宁可拒绝，不要猜」：只要有一个条目没收尾，整个文件就判失败，
 * 上层据此拒绝写入。半解析出来的东西绝不能拿去覆盖用户文件。
 */

const TYPE_CHARS = /[A-Za-z0-9_-]/
const FIELD_NAME_CHARS = /[A-Za-z0-9_:.\-+]/         // biblatex 有 journaltitle / eprint-type 这类名字
const WORD_CHARS = /[A-Za-z0-9_]/

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

function lineStartsOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** 二分查找：大 .bib 里逐行线性扫描会把 lint 变成 O(n·m)。 */
function lineAt(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * 跳过 @comment / @preamble / @string 的花括号或圆括号体。
 * 这两个字符集要分开数：`@string(x = "a)b")` 里的 ')' 在引号内不算收尾。
 */
function skipBalancedBody(text, i, openChar, startLine) {
  const n = text.length
  if (openChar === '{') {
    let depth = 1
    while (i < n) {
      const c = text[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return { ok: true, end: i + 1 }
      }
      i++
    }
  } else {
    let parens = 1
    let braces = 0
    while (i < n) {
      const c = text[i]
      if (c === '{') braces++
      else if (c === '}') {
        if (braces > 0) braces--
      } else if (braces === 0 && c === '(') parens++
      else if (braces === 0 && c === ')') {
        parens--
        if (parens === 0) return { ok: true, end: i + 1 }
      }
      i++
    }
  }
  return { ok: false, error: { message: `从第 ${startLine} 行开始的 @ 块到文件末尾仍未闭合`, line: startLine } }
}

function parseEntryAt(text, at, lineOf) {
  const n = text.length
  let i = at + 1

  const skipWs = () => {
    while (i < n && isWs(text[i])) i++
  }

  skipWs()
  const typeStart = i
  while (i < n && TYPE_CHARS.test(text[i])) i++
  const rawType = text.slice(typeStart, i)
  // 邮箱、URL 里也会出现 '@'；后面不跟 { 或 ( 就不是条目，当普通字符跳过。
  if (!rawType) return { ok: true, junk: true, end: at + 1 }
  const type = rawType.toLowerCase()

  skipWs()
  const openChar = text[i]
  if (openChar !== '{' && openChar !== '(') return { ok: true, junk: true, end: at + 1 }
  const openIndex = i
  const closeChar = openChar === '{' ? '}' : ')'
  const atLine = lineOf(at)
  i++

  if (type === 'comment' || type === 'preamble' || type === 'string') {
    const skipped = skipBalancedBody(text, i, openChar, atLine)
    if (!skipped.ok) return skipped
    // junk 而非 entry：这三类不是文献条目，不该进条目表，也不该进引用比对
    return { ok: true, junk: true, end: skipped.end }
  }

  // key：允许 @misc{some-key, ...}，也允许 key 后直接收尾（空条目）
  skipWs()
  const keyStart = i
  while (i < n) {
    const c = text[i]
    if (isWs(c) || c === ',' || c === '{' || c === '(' || c === '}' || c === ')') break
    i++
  }
  const key = text.slice(keyStart, i)
  const keyEnd = keyStart + key.length
  skipWs()

  if (i >= n) {
    return { ok: false, error: { message: `条目 "${key}"（第 ${atLine} 行）缺少闭合的 '${closeChar}'`, line: atLine } }
  }

  const finishEmpty = () => ({
    ok: true,
    entry: {
      type, rawType, key,
      line: atLine, typeStart, keyStart, keyEnd,
      openIndex, closeIndex: i, bodyStart: openIndex + 1, bodyEnd: i,
      end: i + 1, fields: [],
    },
    end: i + 1,
  })

  if (text[i] === closeChar) return finishEmpty()
  if (text[i] !== ',') {
    return { ok: false, error: { message: `条目 "${key}"（第 ${atLine} 行）的 key 后面应该是 ',' 或 '${closeChar}'，遇到了 "${text[i]}"`, line: lineOf(i) } }
  }
  if (!key) {
    return { ok: false, error: { message: `第 ${atLine} 行有一个条目没有 key`, line: atLine } }
  }
  i++

  /** 读一个字段值：{...} / "..." / 数字 / @string 宏名，之间可以用 # 拼接。 */
  function readValue() {
    const parts = []
    for (;;) {
      const c = text[i]
      if (c === '{') {
        const innerStart = i + 1
        let depth = 1
        i++
        while (i < n) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') {
            depth--
            if (depth === 0) break
          }
          i++
        }
        if (i >= n) {
          return { error: { message: `第 ${lineOf(innerStart)} 行开始的字段值花括号没有闭合`, line: lineOf(innerStart) } }
        }
        parts.push(text.slice(innerStart, i))
        i++
      } else if (c === '"') {
        const innerStart = i + 1
        let braces = 0
        i++
        while (i < n) {
          const ch = text[i]
          if (ch === '{') braces++
          else if (ch === '}') {
            if (braces > 0) braces--
          } else if (ch === '"' && braces === 0) break
          i++
        }
        if (i >= n) {
          return { error: { message: `第 ${lineOf(innerStart)} 行开始的字段值双引号没有闭合`, line: lineOf(innerStart) } }
        }
        parts.push(text.slice(innerStart, i))
        i++
      } else if (c >= '0' && c <= '9') {
        const s = i
        while (i < n && text[i] >= '0' && text[i] <= '9') i++
        parts.push(text.slice(s, i))
      } else if (c !== undefined && /[A-Za-z]/.test(c)) {
        const s = i
        while (i < n && WORD_CHARS.test(text[i])) i++
        parts.push(text.slice(s, i))
      } else {
        return { error: { message: `第 ${lineOf(i)} 行的字段值无法识别（字符 "${c ?? '文件结束'}"）`, line: lineOf(i) } }
      }
      // 只有在还有 '#' 时才继续吃空白：否则把尾巴上的换行/缩进算进 rawValue，
      // 重建条目时就会多出一个空行。
      const save = i
      skipWs()
      if (text[i] === '#') {
        i++
        skipWs()
        continue
      }
      i = save
      return { value: parts.join('') }
    }
  }

  const fields = []
  for (;;) {
    skipWs()
    if (i >= n) {
      return { ok: false, error: { message: `条目 "${key}"（第 ${atLine} 行）缺少闭合的 '${closeChar}'`, line: atLine } }
    }
    if (text[i] === closeChar) {
      i++
      break
    }
    if (text[i] === ',') {
      i++
      continue
    }
    if (text[i] === '%') {
      // BibTeX 本身不认 % 注释，但真实 .bib 里到处是它。吞掉整行比报错有用。
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    const nameStart = i
    while (i < n && FIELD_NAME_CHARS.test(text[i])) i++
    const rawName = text.slice(nameStart, i)
    if (!rawName) {
      return { ok: false, error: { message: `条目 "${key}" 里出现无法识别的字符 "${text[i]}"（第 ${lineOf(i)} 行）`, line: lineOf(i) } }
    }
    skipWs()
    if (text[i] !== '=') {
      return { ok: false, error: { message: `字段 "${rawName}"（条目 "${key}"，第 ${lineOf(nameStart)} 行）缺少 '='`, line: lineOf(nameStart) } }
    }
    i++
    skipWs()
    const valueStart = i
    const read = readValue()
    if (read.error) return { ok: false, error: read.error }
    fields.push({
      rawName,
      name: rawName.toLowerCase(),
      value: read.value.trim(),
      rawValue: text.slice(valueStart, i),
      line: lineOf(nameStart),
      nameStart,
      nameEnd: nameStart + rawName.length,
      valueStart,
      valueEnd: i,
    })
    skipWs()
    if (i >= n) {
      return { ok: false, error: { message: `条目 "${key}"（第 ${atLine} 行）缺少闭合的 '${closeChar}'`, line: atLine } }
    }
    if (text[i] === closeChar) {
      i++
      break
    }
    if (text[i] !== ',') {
      return { ok: false, error: { message: `条目 "${key}" 的字段 "${rawName}" 后面应该是 ',' 或 '${closeChar}'，遇到了 "${text[i]}"（第 ${lineOf(i)} 行）`, line: lineOf(i) } }
    }
    i++
  }

  return {
    ok: true,
    entry: {
      type, rawType, key,
      line: atLine, typeStart, keyStart, keyEnd,
      openIndex, closeIndex: i - 1, bodyStart: openIndex + 1, bodyEnd: i - 1,
      end: i, fields,
    },
    end: i,
  }
}

/**
 * 解析整个 .bib。
 * 返回的 entries 里每条都带字符偏移，序列化时据此只插入、不改动别处。
 */
export function parseBib(text) {
  const starts = lineStartsOf(text)
  const lineOf = (idx) => lineAt(starts, idx)
  const entries = []
  const errors = []
  const n = text.length
  let i = 0

  while (i < n) {
    const c = text[i]
    if (c === '%') {
      // 顶层注释行整行跳过，避免注释里的 '@article' 被当成真条目
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (c !== '@') {
      i++
      continue
    }
    const parsed = parseEntryAt(text, i, lineOf)
    if (!parsed.ok) {
      errors.push(parsed.error)
      break
    }
    if (parsed.junk) {
      i = parsed.end
      continue
    }
    entries.push(parsed.entry)
    i = parsed.end
  }

  return { ok: errors.length === 0, entries, errors, text }
}

/* ------------------------------------------------------------------ *
 * 必需字段表
 * ------------------------------------------------------------------ */

/**
 * 值可以是字符串（必需）或数组（任意一个即可）。
 * 数组是有原因的：year/date、journal/journaltitle、publisher/howpublished 在各家
 * 工具链里都是等价写法，硬判成缺失只会制造噪音。
 */
const REQUIRED_FIELDS = {
  article: ['author', 'title', ['journal', 'journaltitle'], ['year', 'date']],
  book: [['author', 'editor'], 'title', ['publisher', 'howpublished'], ['year', 'date']],
  booklet: ['title'],
  inbook: [['author', 'editor'], 'title', ['chapter', 'pages'], ['publisher', 'howpublished'], ['year', 'date']],
  incollection: [['author', 'editor'], 'title', 'booktitle', ['publisher', 'howpublished'], ['year', 'date']],
  inproceedings: ['author', 'title', 'booktitle', ['year', 'date']],
  conference: ['author', 'title', 'booktitle', ['year', 'date']],
  proceedings: [['editor', 'organization'], 'title', ['year', 'date']],
  manual: ['title'],
  mastersthesis: ['author', 'title', 'school', ['year', 'date']],
  phdthesis: ['author', 'title', 'school', ['year', 'date']],
  techreport: ['author', 'title', 'institution', ['year', 'date']],
  unpublished: ['author', 'title', 'note'],
  online: [['author', 'editor'], 'title', ['url', 'doi'], ['year', 'date']],
  electronic: [['author', 'editor'], 'title', ['url', 'doi']],
  www: [['author', 'editor'], 'title', 'url'],
  patent: [['author', 'holder'], 'title', ['year', 'date']],
  misc: [], // BibTeX 对 misc 不作要求；强行报缺会变成噪音
}

/** 规范化后的字段顺序：先说清作者/题名，日期、标识符压后。 */
const FIELD_ORDER = [
  'author', 'editor', 'translator', 'title', 'subtitle', 'titleaddon',
  'journal', 'journaltitle', 'booktitle', 'maintitle', 'series',
  'edition', 'volume', 'number', 'issue', 'chapter', 'pages',
  'publisher', 'organization', 'institution', 'school', 'address', 'location',
  'year', 'date', 'month',
  'doi', 'isbn', 'issn', 'eid', 'url', 'urldate', 'eprint', 'eprinttype', 'eprintclass',
  'note', 'howpublished', 'language', 'keywords', 'abstract',
]

const ORDER_INDEX = new Map(FIELD_ORDER.map((name, idx) => [name, idx]))

function orderRank(name) {
  const idx = ORDER_INDEX.get(name)
  return idx === undefined ? FIELD_ORDER.length : idx
}

/** 稳定排序：未收录字段保持原有相对顺序，只被挪到末尾。 */
function orderFields(fields) {
  return fields.slice().sort((a, b) => orderRank(a.name) - orderRank(b.name))
}

/* ------------------------------------------------------------------ *
 * 体检 + 规范化
 * ------------------------------------------------------------------ */

function describeMissing(group) {
  return group.length === 1 ? `"${group[0]}"` : `（${group.map((g) => `"${g}"`).join(' 或 ')}）之一`
}

function collectProblems(parsed) {
  const problems = []
  for (const err of parsed.errors) {
    problems.push({ type: 'parse-error', key: null, line: err.line ?? null, message: err.message, severity: 'error' })
  }

  // 查重：先按原样，再把「仅大小写不同」单列——因为规范化会把 key 压成小写，
  // 这类碰撞不报出来的话，write:true 会当场造出重复 key。
  const seenExact = new Map()
  const seenLower = new Map()
  const collisionKeys = new Set()
  for (const entry of parsed.entries) {
    const exact = seenExact.get(entry.key)
    if (exact) {
      problems.push({
        type: 'duplicate-key', key: entry.key, line: entry.line, severity: 'error',
        message: `条目 key "${entry.key}" 重复（第 ${exact.line} 行已出现一次）`,
      })
    } else {
      seenExact.set(entry.key, entry)
    }
    const lower = entry.key.toLowerCase()
    const same = seenLower.get(lower)
    if (same && same.key !== entry.key) {
      collisionKeys.add(lower)
      problems.push({
        type: 'duplicate-key', key: entry.key, line: entry.line, severity: 'warning',
        message: `条目 key "${entry.key}" 与第 ${same.line} 行的 "${same.key}" 仅大小写不同，规范化 key 时已跳过`,
      })
    } else if (!same) {
      seenLower.set(lower, entry)
    }
  }

  for (const entry of parsed.entries) {
    const required = REQUIRED_FIELDS[entry.type]
    if (required === undefined) {
      problems.push({
        type: 'unknown-entry-type', key: entry.key, line: entry.line, severity: 'warning',
        message: `条目类型 "@${entry.type}" 不在必需字段表里，已跳过字段检查`,
      })
    } else {
      const present = new Set(entry.fields.filter((f) => f.value !== '').map((f) => f.name))
      const inheritsViaCrossref = entry.fields.some((f) => f.name === 'crossref')
      for (const group of required) {
        const oneOf = Array.isArray(group) ? group : [group]
        if (oneOf.some((name) => present.has(name))) continue
        // crossref 继承是合法写法：booktitle/publisher/year 可以来自被引的 @proceedings
        const inherited = inheritsViaCrossref && oneOf.some((n) => n === 'booktitle' || n === 'publisher' || n === 'year' || n === 'editor')
        problems.push({
          type: 'missing-required-field', key: entry.key, line: entry.line,
          severity: inherited ? 'info' : 'error',
          message: inherited
            ? `缺少 ${describeMissing(oneOf)}（可通过 crossref 从上级条目继承，未计入错误）`
            : `缺少必需字段 ${describeMissing(oneOf)}`,
        })
      }
    }

    const seenField = new Map()
    for (const field of entry.fields) {
      const prev = seenField.get(field.name)
      if (prev) {
        problems.push({
          type: 'duplicate-field', key: entry.key, line: field.line, severity: 'warning',
          message: `字段 "${field.name}" 在条目里出现了不止一次（第 ${prev.line} 行也有）`,
        })
      } else {
        seenField.set(field.name, field)
      }
      if (field.value === '') {
        problems.push({
          type: 'empty-field', key: entry.key, line: field.line, severity: 'warning',
          message: `字段 "${field.name}" 是空值`,
        })
      }
    }
  }

  return { problems, collisionKeys }
}

function detectEol(text) {
  // Windows 用户的 .bib 是 CRLF；用 \n 重写会在文件里留下混合换行
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function buildBody(entry, keyLower, orderedFields, eol) {
  if (orderedFields.length === 0) return `${keyLower}${eol}`
  const lines = orderedFields.map((f) => `  ${f.rawName.toLowerCase()} = ${f.rawValue}`)
  return `${keyLower},${eol}${lines.join(`,${eol}`)}${eol}`
}

/**
 * 规范化：entry 类型/key/字段名小写、字段按规范顺序、缩进统一两格。
 *
 * 只重写「花括号内部那段」。@ 块之外的注释、空行、文件尾部原样保留——
 * 这是为什么不用「解析成对象再整体序列化」的做法。
 */
function planNormalization(parsed, collisionKeys) {
  const text = parsed.text
  const eol = detectEol(text)
  const edits = []
  const changes = []

  for (const entry of parsed.entries) {
    const body = text.slice(entry.bodyStart, entry.bodyEnd)
    // 条目里出现 % 就当它含注释：重排字段会把注释挤到别处或吃掉，宁可不规范
    const hasComment = body.includes('%')
    const fieldsLower = entry.fields.map((f) => ({ ...f, name: f.rawName.toLowerCase() }))
    const ordered = orderFields(fieldsLower)
    // 不改 key 的大小写：正文里的 cite 不会跟着改，而 biber 区分大小写，
    // 压成小写等于制造「审计查得到、编译却断链」的假象。真要改得正文和 .bib
    // 一起改，由人决定；这里只在报告里提示一句。
    const keyLower = entry.key
    const kinds = []

    if (entry.rawType !== entry.type) kinds.push('type-case')
    if (entry.key !== entry.key.toLowerCase()) kinds.push('key-case-hint')
    if (entry.fields.some((f) => f.rawName !== f.rawName.toLowerCase())) kinds.push('field-name-case')
    if (ordered.some((f, idx) => f !== fieldsLower[idx])) kinds.push('field-order')

    if (hasComment) {
      // 含注释的条目只修类型大小写，其余留给人
      if (entry.rawType !== entry.type) {
        edits.push({ start: entry.typeStart, end: entry.typeStart + entry.rawType.length, replacement: entry.type })
        changes.push({ key: entry.key, line: entry.line, kinds: ['type-case'], partial: true, detail: `@${entry.rawType} → @${entry.type}（条目内含注释，其余项需人工处理）` })
      }
      continue
    }

    // 类型名在 @ 与 { 之间，不在 body 里，所以单独一条 edit
    if (entry.rawType !== entry.type) {
      edits.push({ start: entry.typeStart, end: entry.typeStart + entry.rawType.length, replacement: entry.type })
    }

    const newBody = buildBody(entry, keyLower, ordered, eol)
    if (newBody === body) {
      if (kinds.length === 0) continue
      // body 已经合规，只有类型名要改
      changes.push({ key: entry.key, line: entry.line, kinds, detail: kinds.map((k) => describeKind(k, entry, keyLower, ordered)).join('；') })
      continue
    }
    if (kinds.length === 0) kinds.push('whitespace')
    edits.push({ start: entry.bodyStart, end: entry.bodyEnd, replacement: newBody })
    changes.push({
      key: entry.key, line: entry.line, kinds,
      detail: kinds.map((k) => describeKind(k, entry, keyLower, ordered)).join('；'),
    })
  }

  return { edits, changes }
}

function describeKind(kind, entry, keyLower, ordered) {
  switch (kind) {
    case 'type-case':
      return `@${entry.rawType} → @${entry.type}`
    case 'key-case-hint':
      return `key "${entry.key}" 含大写。biber 区分大小写，这个工具不会替你改——要改请把正文里的 \\cite 一起改`
    case 'field-name-case':
      return '字段名改为小写'
    case 'field-order':
      return `字段重排为 ${ordered.map((f) => f.name).join(', ')}`
    default:
      return '空白/缩进规范化'
  }
}

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start) // 从后往前改，前面的偏移量才不会失效
  let out = text
  for (const edit of sorted) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  return out
}

/** 体检主入口：纯函数，不碰磁盘。 */
export function lintBib(text) {
  const parsed = parseBib(text)
  const { problems, collisionKeys } = collectProblems(parsed)

  let normalizedText = text
  let changes = []
  if (parsed.ok) {
    const plan = planNormalization({ text, entries: parsed.entries }, collisionKeys)
    changes = plan.changes
    normalizedText = applyEdits(text, plan.edits)
  }

  const blocking = problems.some((p) => p.severity === 'error')
  return {
    ok: parsed.ok && !blocking,
    parsed,
    entries: parsed.entries.length,
    entryList: parsed.entries.map((e) => ({ key: e.key, type: e.type, line: e.line })),
    problems,
    changes,
    normalizedText,
    normalizedChanged: normalizedText !== text,
  }
}

/* ------------------------------------------------------------------ *
 * 补全：只填空字段，只做插入
 * ------------------------------------------------------------------ */

/** 把 JSON/Crossref/S2 里的值洗成能安全塞进 BibTeX 花括号的字符串。 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function plainText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '') // Crossref 的标题里常带 <i>、<sub>
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
}

export function bibSafeValue(value) {
  // 花括号必须配平，否则整个文件解析崩掉；转义而不是删掉，内容还是原意。
  // 反斜杠也一并规范：一个孤零零的 `\` 会吃掉后面的收尾花括号。
  const text = plainText(value).replace(/\s+/g, ' ').trim()
  return text.replace(/(\\*)\{/g, '$1\\{').replace(/(\\*)\}/g, '$1\\}')
}

export function formatAuthorList(authors) {
  if (!Array.isArray(authors)) return ''
  const names = []
  for (const author of authors) {
    if (!author) continue
    if (typeof author === 'string') {
      names.push(author.trim())
      continue
    }
    if (author.name) {
      names.push(String(author.name).trim()) // Semantic Scholar 只给整名
      continue
    }
    const given = String(author.given ?? '').trim()
    const family = String(author.family ?? '').trim()
    if (family && given) names.push(`${family}, ${given}`)
    else if (family || given) names.push(family || given)
  }
  return names.filter(Boolean).join(' and ')
}

/** 条目里已有（且非空）的字段名集合。 */
export function presentFields(entry) {
  const set = new Set()
  for (const field of entry.fields) if (field.value !== '') set.add(field.name)
  return set
}

/**
 * 条目里出现过的所有字段名，含值为空的。
 *
 * 判断「还能不能再补一个字段」必须用它：presentFields 把空值当成缺失，
 * 于是 `title = {}` 会被补成第二个 title，BibTeX 对重复字段的行为没有定义。
 */
export function existingFields(entry) {
  return new Set(entry.fields.map((field) => field.name))
}

export function entryDoi(entry) {
  const field = entry.fields.find((f) => f.name === 'doi')
  if (!field) return null
  return normalizeDoi(field.value)
}

export function normalizeDoi(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  // 常见写法：https://doi.org/10.x/y、doi:10.x/y、{10.x/y}
  const stripped = raw
    .replace(/^\{+|\}+$/g, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
  return /^10\.\d{4,9}\/\S+$/.test(stripped) ? stripped : null
}

export function entryTitle(entry) {
  const field = entry.fields.find((f) => f.name === 'title')
  return field ? plainText(field.value).trim() : ''
}

/**
 * 把一份外部记录（Crossref / Semantic Scholar）套到条目上。
 * 红线：已有值的字段一律不碰，值再难看也不动。
 */
export function mergeRecord(entry, record) {
  const present = existingFields(entry)
  const candidates = record && record.fields ? record.fields : {}
  const added = {}
  for (const [name, value] of Object.entries(candidates)) {
    const field = name.toLowerCase()
    if (present.has(field)) continue
    const safe = bibSafeValue(value)
    if (!safe) continue
    added[field] = safe
  }
  return added
}

/**
 * 把补全结果写回文本：只在上一个字段值的末尾插 `,\n  name = {value}`。
 * 不做整体重排，因此 @ 块外的注释、@string、文件尾部一个字都不会动。
 */
export function applyFills(text, parsed, fills) {
  const eol = detectEol(text)
  const byKey = new Map()
  for (const entry of parsed.entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry)
  const edits = []
  const applied = []

  for (const fill of fills) {
    const entry = byKey.get(fill.key)
    if (!entry) continue
    const names = Object.keys(fill.fields)
    if (names.length === 0) continue
    const lines = names.map((name) => `${name} = {${fill.fields[name]}}`)
    const last = entry.fields[entry.fields.length - 1]
    const at = last ? last.valueEnd : entry.keyEnd
    edits.push({ start: at, end: at, replacement: `,${eol}  ${lines.join(`,${eol}  `)}` })
    applied.push({ key: fill.key, fields: { ...fill.fields } })
  }

  if (edits.length === 0) return { text, applied }
  return { text: applyEdits(text, edits), applied }
}

/**
 * 写入前的复核：重新解析，确认还能解析、条目数一致、原有字段值一个没变。
 * 任何一条不满足就拒绝写——这是「绝不许丢尾部」的最后一道闸。
 */
export function verifyFill(originalText, newText, fills) {
  const before = parseBib(originalText)
  const after = parseBib(newText)
  if (!after.ok) {
    return { ok: false, reason: `补全后的内容无法解析：${after.errors[0]?.message ?? '未知原因'}` }
  }
  if (after.entries.length !== before.entries.length) {
    return { ok: false, reason: `条目数从 ${before.entries.length} 变成了 ${after.entries.length}` }
  }
  const afterByKey = new Map(after.entries.map((e) => [e.key, e]))
  for (const entry of before.entries) {
    const next = afterByKey.get(entry.key)
    if (!next) return { ok: false, reason: `条目 "${entry.key}" 在补全后消失了` }
    for (const field of entry.fields) {
      const match = next.fields.find((f) => f.name === field.name)
      if (!match) return { ok: false, reason: `条目 "${entry.key}" 的字段 "${field.name}" 在补全后消失了` }
      if (match.value !== field.value) {
        return { ok: false, reason: `条目 "${entry.key}" 的字段 "${field.name}" 值被改动了` }
      }
    }
  }
  const expected = new Set(fills.filter((f) => Object.keys(f.fields).length > 0).map((f) => f.key))
  for (const key of expected) {
    const next = afterByKey.get(key)
    if (!next) return { ok: false, reason: `补全的条目 "${key}" 在结果里找不到` }
  }
  if (newText.trimEnd().length < originalText.trimEnd().length) {
    return { ok: false, reason: '补全后的内容反而变短了，疑似丢内容' }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 引用比对
 * ------------------------------------------------------------------ */

/**
 * 白名单而不是「名字里带 cite 就算」：`\citetext` 之类名字很像但不吃 key，
 * 误判会把参考文献表搞出假 key。
 */
const CITE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar',
  'citenum', 'citetitle', 'citeurl', 'supercite', 'smartcite', 'notecite', 'citefield',
  'parencite', 'textcite', 'autocite', 'footcite', 'footcitetext', 'textcitetext', 'fullcite',
  'nocite',
])

/**
 * 抹掉注释和 verbatim 内容，但不改变字符数与行数——后面的行号才对得上。
 * % 前有奇数个反斜杠时那是 \%，不是注释。
 */
export function stripCommentsAndVerbatim(text) {
  const blank = (segment) => segment.replace(/[^\n]/g, ' ')
  let out = text
  out = out.replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|comment|minted)\}[\s\S]*?\\end\{\1\}/g, blank)
  out = out.replace(/\\verb\*?([^A-Za-z\s])(?:(?!\1)[^\n])*\1/g, blank)

  const chars = out.split('')
  const n = out.length
  let i = 0
  while (i < n) {
    if (out[i] !== '%') {
      i++
      continue
    }
    let backslashes = 0
    let k = i - 1
    while (k >= 0 && out[k] === '\\') {
      backslashes++
      k--
    }
    if (backslashes % 2 === 1) {
      i++
      continue
    }
    while (i < n && out[i] !== '\n') {
      chars[i] = ' '
      i++
    }
  }
  return chars.join('')
}

function readOptionalArg(text, i) {
  const n = text.length
  let depth = 0
  let braces = 0
  let j = i + 1
  while (j < n) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '{') braces++
    else if (c === '}') {
      if (braces > 0) braces--
    } else if (braces === 0 && c === '[') depth++
    else if (braces === 0 && c === ']') {
      if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }
      depth--
    }
    j++
  }
  return null
}

function readBracedArg(text, i) {
  const n = text.length
  let depth = 1
  let j = i + 1
  while (j < n) {
    const c = text[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }
    }
    j++
  }
  return null
}

/**
 * 提取 .tex 里的引用。
 * 支持 \cite{a,b} 多 key、\citep[见][p.3]{key} 前置可选参数、星号变体。
 */
export function extractCites(texText, file) {
  const text = stripCommentsAndVerbatim(texText)
  const starts = lineStartsOf(text)
  const cites = []
  const undCitations = []
  let noCiteAll = false
  const n = text.length
  let i = 0

  while (i < n) {
    const at = text.indexOf('\\', i)
    if (at < 0) break
    let j = at + 1
    while (j < n && text[j] === '\\') j++ // \\cite 这种换行后接命令的写法
    const nameStart = j
    while (j < n && /[A-Za-z]/.test(text[j])) j++
    const command = text.slice(nameStart, j)
    if (!CITE_COMMANDS.has(command)) {
      i = at + 1
      continue
    }
    let cursor = j
    if (text[cursor] === '*') cursor++
    while (cursor < n && isWs(text[cursor])) cursor++

    let optionalCount = 0
    while (text[cursor] === '[') {
      const arg = readOptionalArg(text, cursor)
      if (!arg) break
      optionalCount++
      cursor = arg.end
      while (cursor < n && isWs(text[cursor])) cursor++
    }

    if (text[cursor] !== '{') {
      // 命令存在但没带 key（定制的宏、或 \citep 后面不是花括号）
      undCitations.push(`${file}:${lineAt(starts, at)} 的 \\${command} 后面没有找到 {keys}`)
      i = at + 1
      continue
    }
    const group = readBracedArg(text, cursor)
    if (!group) {
      i = at + 1
      continue
    }
    const line = lineAt(starts, at)
    for (const piece of group.content.split(',')) {
      const key = piece.trim()
      if (!key) continue
      if (key === '*') {
        noCiteAll = true // \nocite{*}：全库都算被引用
        continue
      }
      cites.push({ key, command, file, line, optionalCount })
    }
    i = group.end
  }

  return { cites, noCiteAll, warnings: undCitations }
}

/**
 * 比对：.tex 引用 vs .bib 条目。
 * neverCited 在 \nocite{*} 出现时按「全部被引用」处理，并如实标注。
 */
export function auditCites({ citations, entries, noCiteAll, warnings }) {
  const entryKeys = new Set(entries.map((e) => e.key))
  const lowerToKeys = new Map()
  for (const entry of entries) {
    const lower = entry.key.toLowerCase()
    if (!lowerToKeys.has(lower)) lowerToKeys.set(lower, [])
    lowerToKeys.get(lower).push(entry.key)
  }

  const citedMap = new Map()
  for (const cite of citations) {
    if (!citedMap.has(cite.key)) citedMap.set(cite.key, [])
    citedMap.get(cite.key).push(cite)
  }

  const citedButMissing = []
  const matchedEntries = new Set()
  for (const [key, list] of citedMap) {
    if (entryKeys.has(key)) {
      matchedEntries.add(key)
      continue
    }
    // BibTeX 的 key 比对不区分大小写，仅大小写不同不算缺失
    const lowerMatches = lowerToKeys.get(key.toLowerCase())
    if (lowerMatches && lowerMatches.length > 0) {
      matchedEntries.add(lowerMatches[0])
      continue
    }
    citedButMissing.push({
      key,
      count: list.length,
      locations: list.slice(0, 20).map((c) => `${c.file}:${c.line} \\${c.command}`),
    })
  }

  const neverCited = noCiteAll
    ? []
    : entries
        .filter((e) => !matchedEntries.has(e.key))
        .map((e) => ({ key: e.key, type: e.type, line: e.line }))

  return {
    totalEntries: entries.length,
    totalCited: citedMap.size,
    citedButMissing: citedButMissing.sort((a, b) => a.key.localeCompare(b.key)),
    neverCited,
    noCiteAll,
    warnings,
  }
}
