'use strict'

const { auditAnswer } = require('../lib/answer-audit')

const TOOL = 'NVDA [LIVE PRICE: $209.87] — Signal: BUY (71% confidence)\nRSI(14): 62.4 · support 205.10 · resistance 218.40 · P/E 31.2x'

test('figures in the tool data pass, at the precision they were written; invented ones are named', () => {
  const a = auditAnswer('**NVDA** is at $209.87 (≈$210) with RSI 62.4 and a 31.2x P/E. A move to $212 would be +14.2%.', [TOOL])
  expect(a.verdict).toBe('unsupported-figures')
  expect(a.unsupported).toEqual([{ sentence: 'A move to $212 would be +14.2%.', figures: ['212', '14.2'] }])
  expect(a.unsupportedCount).toBe(2)
})

test('counts, list numbers, years and the disclaimer are not quantities', () => {
  const a = auditAnswer('Here are 3 ideas for 2026:\n1. NVDA at $209.87\n2. Support near $205\nNot financial advice — consult a qualified professional. Past performance does not guarantee future results.', [TOOL])
  expect(a.verdict).toBe('all-supported')
})

test("the user's own figures count as evidence; no evidence at all leaves the audit inert", () => {
  expect(auditAnswer('You said your budget is $5,000 — NVDA at $209.87 fits.', [TOOL, 'I have $5,000 to invest']).verdict).toBe('all-supported')
  expect(auditAnswer('NVDA will hit $500.', []).verdict).toBe('unverifiable')
  expect(auditAnswer('The macro regime looks balanced.', [TOOL]).verdict).toBe('no-figures')
})
