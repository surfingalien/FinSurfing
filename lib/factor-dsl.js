'use strict'

/**
 * lib/factor-dsl.js — factors a model proposes, as data, judged like any other.
 *
 * AlphaAgent / QuantaAlpha / RD-Agent have a model propose factor formulas and
 * a backtest judge them. Two things from that line of work matter here: the
 * formula must be something code can check before it runs (no model-written
 * code is ever executed — same rule as lib/strategy-dsl.js), and a "new"
 * factor that ranks stocks the same way as an existing one is not new
 * (AlphaAgent's originality check) — it only adds a trial that can get lucky.
 *
 * Grammar (numeric expression tree over lib/strategy-dsl.js FEATURES):
 *   { feature: 'rsi14' } | { const: 2 }
 *   { op: 'add'|'sub'|'mul'|'div', left, right }
 *   { op: 'neg'|'abs', operand }
 *   { op: 'lag'|'mean'|'std', operand, n }      n = 1…252 bars, looking BACK only
 * ≤ MAX_NODES nodes, ≤ MAX_DEPTH deep. Every operation reads bars ≤ i, so an
 * expression cannot see the future; tests pin it.
 *
 * Accepted proposals join lib/factor-mining.js as ordinary candidates: the
 * same IC walk-forward, the same deflated-Sharpe gate, and each one counts as
 * a trial in both directions. Pure except `proposeFactors` (one LLM call).
 * Tests: tests/factor-dsl.test.js
 */

const { FEATURES, featureContext } = require('./strategy-dsl')

const MAX_NODES = 12
const MAX_DEPTH = 5
const BINARY = ['add', 'sub', 'mul', 'div']
const UNARY = ['neg', 'abs']
const WINDOW = ['lag', 'mean', 'std']
const ORIGINALITY_MAX = 0.7      // mean |rank correlation| with an existing factor at or above this ⇒ duplicate

class ExprError extends Error {}

function validateExpr(node, depth = 1, counter = { n: 0 }) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new ExprError('every node must be an object')
  if (++counter.n > MAX_NODES) throw new ExprError(`more than ${MAX_NODES} nodes`)
  if (depth > MAX_DEPTH) throw new ExprError(`deeper than ${MAX_DEPTH}`)
  if ('feature' in node) {
    if (!FEATURES[node.feature]) throw new ExprError(`unknown feature "${node.feature}"`)
    return
  }
  if ('const' in node) {
    if (!Number.isFinite(node.const)) throw new ExprError('const must be a finite number')
    return
  }
  if (BINARY.includes(node.op)) { validateExpr(node.left, depth + 1, counter); validateExpr(node.right, depth + 1, counter); return }
  if (UNARY.includes(node.op)) { validateExpr(node.operand, depth + 1, counter); return }
  if (WINDOW.includes(node.op)) {
    if (!Number.isInteger(node.n) || node.n < 1 || node.n > 252) throw new ExprError(`${node.op} needs an integer n from 1 to 252`)
    validateExpr(node.operand, depth + 1, counter)
    return
  }
  throw new ExprError(`unknown op "${node.op}"`)
}

/** Parse + validate; returns { ok, expr } or { ok: false, reason }. Accepts an object or JSON text. */
function parseExpr(raw) {
  try {
    const expr = typeof raw === 'string' ? JSON.parse(raw) : raw
    validateExpr(expr)
    if (!JSON.stringify(expr).includes('"feature"')) throw new ExprError('uses no feature — a constant ranks nothing')
    return { ok: true, expr }
  } catch (e) {
    return { ok: false, reason: e instanceof ExprError ? e.message : `not valid JSON (${e.message})` }
  }
}

/** Evaluate to a full series (NaN where undefined). Every op is causal. */
function evalExpr(node, ctx) {
  const n = ctx.length
  if ('feature' in node) return ctx.get(node.feature)
  if ('const' in node) return new Array(n).fill(node.const)
  if (BINARY.includes(node.op)) {
    const a = evalExpr(node.left, ctx), b = evalExpr(node.right, ctx)
    return a.map((x, i) => {
      const y = b[i]
      if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN
      if (node.op === 'add') return x + y
      if (node.op === 'sub') return x - y
      if (node.op === 'mul') return x * y
      return Math.abs(y) < 1e-12 ? NaN : x / y
    })
  }
  const a = evalExpr(node.operand, ctx)
  if (node.op === 'neg') return a.map(x => -x)
  if (node.op === 'abs') return a.map(x => Math.abs(x))
  const k = node.n
  if (node.op === 'lag') return a.map((_, i) => (i - k >= 0 ? a[i - k] : NaN))
  return a.map((_, i) => {
    if (i - k + 1 < 0) return NaN
    const w = a.slice(i - k + 1, i + 1)
    if (w.some(x => !Number.isFinite(x))) return NaN
    const m = w.reduce((s, x) => s + x, 0) / k
    if (node.op === 'mean') return m
    return k < 2 ? NaN : Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1))
  })
}

function describeExpr(node) {
  if ('feature' in node) return node.feature
  if ('const' in node) return String(node.const)
  if (BINARY.includes(node.op)) return `(${describeExpr(node.left)} ${{ add: '+', sub: '−', mul: '×', div: '÷' }[node.op]} ${describeExpr(node.right)})`
  if (UNARY.includes(node.op)) return `${node.op}(${describeExpr(node.operand)})`
  return `${node.op}(${describeExpr(node.operand)}, ${node.n})`
}

/** A factor-mining candidate from an expression: fn(p, i) reads its cached series. */
function toFactor(name, expr, label = null) {
  return {
    label: label || describeExpr(expr), expression: expr, source: 'llm',
    fn: (p, i) => {
      p._expr ||= {}
      if (!p._expr[name]) {
        const bars = { closes: p.c, opens: p.o || p.c, highs: p.h, lows: p.l, volumes: p.v }
        try { p._expr[name] = evalExpr(expr, featureContext(bars)) } catch { p._expr[name] = [] }
      }
      const v = p._expr[name][i]
      return Number.isFinite(v) ? v : null
    },
  }
}

/**
 * Originality: mean |Spearman| between a candidate and each existing factor
 * over the given cross-sections. Returns { duplicateOf, rho } or null. Pure.
 */
function originality(candidate, existing, panel, dates, spearman) {
  let worst = null
  for (const [name, f] of Object.entries(existing)) {
    const rhos = []
    for (const date of dates) {
      const a = [], b = []
      for (const p of Object.values(panel)) {
        const i = p.idx.get(date)
        if (i == null) continue
        const x = candidate.fn(p, i), y = f.fn(p, i)
        if (Number.isFinite(x) && Number.isFinite(y)) { a.push(x); b.push(y) }
      }
      const r = a.length >= 8 ? spearman(a, b) : null
      if (r != null) rhos.push(Math.abs(r))
    }
    if (!rhos.length) continue
    const rho = rhos.reduce((s, x) => s + x, 0) / rhos.length
    if (!worst || rho > worst.rho) worst = { duplicateOf: name, rho: +rho.toFixed(3) }
  }
  return worst
}

// ── Proposal (one LLM call) ──────────────────────────────────────────────────

function buildFactorPrompt({ existing = [], count = 6 }) {
  const feats = Object.entries(FEATURES).map(([k, f]) => `- ${k}: ${f.desc}`).join('\n')
  return `You propose CROSS-SECTIONAL stock factors: a number computed for every stock on a day, used to RANK stocks by their likely return over the next month.

FEATURES (daily series per stock):
${feats}

GRAMMAR — an expression is a JSON tree, nothing else:
  {"feature":"rsi14"}   {"const":2}
  {"op":"add"|"sub"|"mul"|"div","left":<expr>,"right":<expr>}
  {"op":"neg"|"abs","operand":<expr>}
  {"op":"lag"|"mean"|"std","operand":<expr>,"n":<1..252>}   (lag/mean/std over the PAST n bars)
At most ${MAX_NODES} nodes. Prefer scale-free ratios (e.g. close ÷ sma200), not raw prices.

ALREADY TESTED (do not repeat these ideas or close variants):
${existing.map(e => `- ${e}`).join('\n') || '- none'}

Propose up to ${count} genuinely different factors. Each: a short snake_case name, a one-sentence hypothesis for WHY it should rank next-month returns, and the expression as a JSON string. You will not see results here: every factor is tested on years of data and discarded unless it survives a walk-forward test corrected for how many factors were tried.`
}

/**
 * Ask the router for proposals, then validate each. Returns
 * [{ name, hypothesis, expression|null, status: 'ok'|'invalid', reason }].
 */
async function proposeFactors({ router, existing = [], count = 6 }) {
  const { FACTOR_PROPOSALS_SCHEMA } = require('./ai-schemas')
  const r = await router.call({
    prompt: buildFactorPrompt({ existing, count }), maxTokens: 2500,
    schema: FACTOR_PROPOSALS_SCHEMA, schemaName: 'factor_proposals',
  })
  const parsed = require('./ai-json').tryParseAiJson(r?.text)
  const seen = new Set()
  return (parsed?.factors || []).slice(0, count).map(f => {
    const name = `llm_${String(f.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40)}`
    if (name === 'llm_' || seen.has(name)) return { name, hypothesis: f.hypothesis, expression: null, status: 'invalid', reason: 'missing or repeated name' }
    seen.add(name)
    const p = parseExpr(f.expression)
    return p.ok
      ? { name, hypothesis: String(f.hypothesis || '').slice(0, 300), expression: p.expr, status: 'ok' }
      : { name, hypothesis: String(f.hypothesis || '').slice(0, 300), expression: null, status: 'invalid', reason: p.reason }
  })
}

module.exports = {
  MAX_NODES, MAX_DEPTH, ORIGINALITY_MAX, ExprError,
  validateExpr, parseExpr, evalExpr, describeExpr, toFactor, originality, buildFactorPrompt, proposeFactors,
}
