import test from 'node:test'
import assert from 'node:assert/strict'

import { lookupEntry, mapCrossrefWork, titlesLookAlike } from '../src/lib/crossref.js'

test('真实 Crossref 形状的日期能解析出 year', () => {
  const work = {
    title: ['A Paper'],
    issued: { 'date-parts': [[2015, 10, 28]] },
    'container-title': ['Nature'],
    DOI: '10.1038/nature14539',
  }
  const fields = mapCrossrefWork(work, 'article')
  assert.equal(fields.year, '2015')
  assert.equal(fields.journal, 'Nature')
  assert.equal(fields.doi, '10.1038/nature14539')
})

test('数组形状的日期仍然兼容', () => {
  assert.equal(mapCrossrefWork({ issued: [[1999]] }, 'article').year, '1999')
})

test('只差一个词的标题不能被判为同一篇', () => {
  const lung = 'Deep learning for lung cancer diagnosis'
  const breast = 'Deep learning for breast cancer diagnosis'
  assert.equal(titlesLookAlike(lung, breast), false)
})

test('完全一致、大小写和标点差异仍然匹配', () => {
  const title = 'Deep Learning for Lung Cancer Diagnosis'
  assert.equal(titlesLookAlike(title, title), true)
  assert.equal(titlesLookAlike(title, 'deep learning for lung cancer diagnosis.'), true)
})

test('毫不相关的标题不匹配', () => {
  assert.equal(titlesLookAlike('Deep learning', 'Quantum chromodynamics lattice'), false)
})

test('空标题不匹配任何东西', () => {
  assert.equal(titlesLookAlike('', 'anything at all'), false)
  assert.equal(titlesLookAlike('the of and', 'anything at all'), false)
})

const mkResponse = (obj) => ({ ok: true, status: 200, json: async () => obj })

const PAPER = {
  title: ['Deep learning for cancer diagnosis'],
  DOI: '10.1/OTHER-PAPER',
  author: [{ family: 'Doe', given: 'J' }],
  issued: { 'date-parts': [[2019]] },
  'container-title': ['Some Journal'],
}

test('标题歧义时不降级到备用源（整条 lookupEntry 链路）', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('api.crossref.org')) {
        // 两条同名不同 DOI：预印本与期刊版并存时的真实形状
        return mkResponse({ message: { items: [PAPER, { ...PAPER, DOI: "10.1/SECOND" }] } })
      }
      if (u.includes('semanticscholar')) {
        return mkResponse({ data: [{ title: PAPER.title[0], externalIds: { DOI: '10.1/OTHER-PAPER' }, authors: [{ name: 'Doe J' }], year: 2019, venue: 'Some Journal' }] })
      }
      throw new Error('unexpected url ' + u)
    }
    const result = await lookupEntry({ doi: null, title: PAPER.title[0], entryType: 'article' })
    assert.equal(result.ok, false, '歧义必须拒绝，不能把别的论文放进来')
    assert.equal(result.status, 'ambiguous')
    assert.equal(result.attempts.length, 1, '歧义后不应再询问第二个来源')
  } finally {
    globalThis.fetch = original
  }
})

test('来源真正不可达时仍然降级到备用源', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('api.crossref.org')) {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
      }
      if (u.includes('semanticscholar')) {
        return mkResponse({ data: [{ title: PAPER.title[0], externalIds: { DOI: '10.1/OK' }, authors: [{ name: 'Doe J' }], year: 2019, venue: 'J' }] })
      }
      throw new Error('unexpected url ' + u)
    }
    const result = await lookupEntry({ doi: null, title: PAPER.title[0], entryType: 'article' })
    assert.equal(result.ok, true, '不可达属于可重试，应降级成功')
    assert.equal(result.source, 'semantic-scholar')
  } finally {
    globalThis.fetch = original
  }
})
