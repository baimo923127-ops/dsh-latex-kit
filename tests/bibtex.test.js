import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyFills,
  existingFields,
  lintBib,
  mergeRecord,
  parseBib,
  presentFields,
  verifyFill,
} from '../src/lib/bibtex.js'

test('合法条目不会因为 lint 被改动', () => {
  const bib = '@article{k1,\n  author = {A, B},\n  title = {T},\n  journal = {J},\n  year = {2020}\n}\n'
  const result = lintBib(bib)
  assert.equal(result.ok, true)
  assert.equal(result.normalizedChanged, false)
})

test('lint 不改引用 key 的大小写，只提示', () => {
  const bib = '@article{Smith2024,\n  author = {Smith, A.},\n  title = {A Study},\n  journal = {J.},\n  year = {2024}\n}\n'
  const result = lintBib(bib)
  const kinds = result.changes.flatMap((c) => c.kinds ?? [])
  assert.ok(!kinds.includes('key-case'), '不应该有 key-case 编辑')
  assert.ok(kinds.includes('key-case-hint'), '应该有提示')
  assert.match(result.normalizedText, /Smith2024/, 'key 必须原样保留')
  assert.equal(result.normalizedChanged, false)
})

test('已有空值字段不会被再补一个，避免重复字段', () => {
  const bib = '@article{k1,\n  title = {},\n  year = {2020}\n}\n'
  const parsed = parseBib(bib)
  const entry = parsed.entries[0]

  assert.ok(presentFields(entry).has('title') === false, 'presentFields 把空值视为缺失')
  assert.ok(existingFields(entry).has('title'), 'existingFields 认得空值字段存在')

  const added = mergeRecord(entry, { fields: { title: 'Filled', journal: 'Nature' } })
  assert.equal('title' in added, false, '空 title 不应被当成缺失')
  assert.equal(added.journal, 'Nature', '真正缺失的字段照补')

  const out = applyFills(bib, parsed, [{ key: 'k1', fields: added }])
  assert.equal((out.text.match(/title\s*=/g) ?? []).length, 1, '写回后 title 只能有一份')
  assert.equal(verifyFill(bib, out.text, [{ key: 'k1', fields: added }]).ok, true)
})

test('补全绝不覆盖已有值，包括原始写法', () => {
  const bib = '@article{lecun2015,\n  author = {LeCun, Yann},\n  year   = {2015 },\n  title = {Deep learning}\n}\n'
  const parsed = parseBib(bib)
  const added = mergeRecord(parsed.entries[0], {
    fields: { author: 'WRONG', year: '1900', title: 'WRONG', pages: '1--2' },
  })
  assert.deepEqual(added, { pages: '1--2' })

  const out = applyFills(bib, parsed, [{ key: 'lecun2015', fields: added }])
  assert.match(out.text, /author = \{LeCun, Yann\}/)
  assert.match(out.text, /year   = \{2015 \}/, '连原始空格都不能被美化')
})

test('解析失败时 verifyFill 必须拒绝，不许丢尾部', () => {
  const broken = '@article{bad,\n  title = {x}\n'
  const parsed = parseBib(broken)
  assert.equal(parsed.ok, false)
  assert.ok(parsed.errors.length > 0)

  const good = '@article{k,\n  title = {x}\n}\n'
  const truncated = '@article{k,\n  title = {x}\n'
  assert.equal(verifyFill(good, truncated, [{ key: 'k', fields: { pages: '1' } }]).ok, false)
})

test('CRLF 文件规范化后不掺 LF', () => {
  const crlf = '@article{k,\r\n  author = {A, B},\r\n  title = {x},\r\n  journal = {J},\r\n  year = {2020}\r\n}\r\n'
  const result = lintBib(crlf)
  assert.equal(result.ok, true)
  assert.ok(!/[^\r]\n/.test(result.normalizedText), '不应出现裸 LF')
})
