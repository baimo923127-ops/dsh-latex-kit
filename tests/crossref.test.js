import test from 'node:test'
import assert from 'node:assert/strict'

import { mapCrossrefWork, titlesLookAlike } from '../src/lib/crossref.js'

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
