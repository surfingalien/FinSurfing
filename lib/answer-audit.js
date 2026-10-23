'use strict'

/**
 * lib/answer-audit.js — every figure in a copilot answer, checked against the
 * data the tools actually returned.
 *
 * The copilot's system prompt forbids quoting prices or figures from memory,
 * and the Advisory citation gate (lib/claim-support.js) enforces the same rule
 * there. The copilot had no check at all: an answer could state "$212 target,
 * up 14.2%" with neither number in any tool result, and read exactly like one
 * that was grounded. Dexter (virattt/dexter) adds a separate validation AGENT
 * for this; here it is code, no model call: each sentence's figures are looked
 * up in the evidence with claim-support's rounding rule ($209.87 supports
 * $210, not $212).
 *
 * The answer has already streamed, so nothing is deleted — the audit is sent
 * as its own event and shown under the answer, naming the figures. Counts and
 * list numbers (integers up to 10), calendar years and the disclaimer are not
 * quantities and are skipped. A figure the model DERIVED (a % change it
 * computed) is reported too, worded as "not found", not "wrong": derived
 * numbers are exactly the ones a reader should be able to trace.
 *
 * Pure. Tests: tests/answer-audit.test.js
 */

const { extractNumbers, numberSupported } = require('./claim-support')

const SKIP_LINE = /not financial advice|past performance|consult a qualified/i
const MAX_REPORTED = 5

const plain = s => String(s || '').replace(/\*\*|__|`|^#+\s*|^\s*[-*•]\s+|^\s*\d+\.\s+/gm, '').replace(/\|/g, ' ')

function isQuantity(n) {
  if (Number.isInteger(n.value) && Math.abs(n.value) <= 10 && n.decimals === 0 && !/[%$]/.test(n.raw)) return false
  if (Number.isInteger(n.value) && n.value >= 1990 && n.value <= 2100 && n.decimals === 0) return false
  return true
}

/**
 * @param {string}   answer    the full assistant text
 * @param {string[]} evidence  every tool result served this turn, plus the user's own words
 * @returns {{verdict, checked, unsupportedCount, unsupported: Array<{sentence, figures}>}}
 */
function auditAnswer(answer, evidence, { maxReported = MAX_REPORTED } = {}) {
  const ev = (evidence || []).filter(Boolean).join('\n')
  if (!ev.trim()) return { verdict: 'unverifiable', checked: 0, unsupportedCount: 0, unsupported: [] }
  const evNums = extractNumbers(ev)
  const sentences = plain(answer).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)
  let checked = 0
  const unsupported = []
  for (const s of sentences) {
    if (SKIP_LINE.test(s)) continue
    const nums = extractNumbers(s).filter(isQuantity)
    checked += nums.length
    const missing = nums.filter(n => !numberSupported(n, evNums)).map(n => n.raw)
    if (missing.length) unsupported.push({ sentence: s.slice(0, 200), figures: [...new Set(missing)] })
  }
  return {
    verdict: !checked ? 'no-figures' : unsupported.length ? 'unsupported-figures' : 'all-supported',
    checked,
    unsupportedCount: unsupported.reduce((a, u) => a + u.figures.length, 0),
    unsupported: unsupported.slice(0, maxReported),
  }
}

module.exports = { auditAnswer }
