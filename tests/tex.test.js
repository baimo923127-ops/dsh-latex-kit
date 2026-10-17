import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLatexLog } from '../src/lib/tex.js'

const BODY = [
  '(./main.tex',
  'LaTeX2e <2024-06-01>',
  'l.3 \\badcommand',
  '! Undefined control sequence.',
  'l.3 \\badcommand',
  ')',
].join('\n')

test('LF 日志能把错误定位到文件和行号', () => {
  const result = parseLatexLog(BODY + '\n')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].file, './main.tex')
  assert.equal(result.errors[0].line, 3)
  assert.match(result.errors[0].message, /Undefined control sequence/)
})

test('CRLF 日志与 LF 日志定位结果必须一致', () => {
  const lf = parseLatexLog(BODY + '\n')
  const crlf = parseLatexLog(BODY.replace(/\n/g, '\r\n') + '\r\n')
  assert.equal(crlf.errors[0].file, './main.tex', 'CRLF 不能丢文件名')
  assert.equal(crlf.errors[0].line, lf.errors[0].line)
  assert.equal(crlf.errors[0].message, lf.errors[0].message)
})

test('多层 include 时错误归属到最内层的文件', () => {
  const log = [
    '(./main.tex',
    '(./sections/intro.tex',
    '! Undefined control sequence.',
    'l.7 \\oops',
    ')',
    ')',
  ].join('\n')
  const result = parseLatexLog(log + '\n')
  assert.equal(result.errors[0].file, './sections/intro.tex')
  assert.equal(result.errors[0].line, 7)
})

test('没有错误的日志返回空错误列表', () => {
  const result = parseLatexLog('(./main.tex\nLaTeX2e\n)\n')
  assert.deepEqual(result.errors, [])
})
