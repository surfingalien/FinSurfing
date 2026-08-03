'use strict'
/**
 * lib/strategy-dsl.js
 *
 * WIDENING THE SEARCH SPACE — safely.
 *
 * Until now the Brain could only tune parameters inside four fixed strategy
 * types. It could get better at playing a game whose rules it couldn't
 * rewrite. This module lets it COMPOSE genuinely new strategies — combinations
 * no one wrote down in advance, e.g. "enter when RSI recovers from oversold
 * WHILE price is above EMA200 AND volume is confirming".
 *
 * THE SAFETY MODEL — why this is not "let the LLM write code":
 *   The model never authors, and this file never evaluates, executable code.
 *   There is no eval, no Function(), no code string anywhere in the pipeline.
 *   Instead the model emits a DECLARATIVE JSON RULE TREE which is:
 *     1. VALIDATED against a strict whitelist — unknown feature or operator,
 *        wrong arity, wrong operand type, excess depth/size ⇒ rejected before
 *        anything runs. Validation is allow-list, never deny-list.
 *     2. INTERPRETED by the deterministic evaluator below into a +1/-1/0
 *        signal array. The interpreter can only read precomputed feature
 *        series; it has no I/O, no state, no access to anything else.
 *     3. BACKTESTED by the same engine that grades the built-in strategies
 *        (utils/backtest.js simulateWithSignals), so a novel strategy cannot
 *        be graded on a friendlier scale than a catalog one.
 *   The falsifier is unchanged: the model proposes, the engine judges.
 *
 * Every part of this file is pure. Tests: tests/strategy-dsl.test.js
 */

const { smaSeries, rsiSeries, macdSeries, bbSeries } = require('../utils/backtest')
const { computeEMAArray } = require('./technical-indicators')

// Structural limits — a rule tree is bounded in size and depth so a
// pathological proposal can't cost unbounded evaluation time.
const MAX_NODES = 24
const MAX_DEPTH = 6

// ── Feature registry (the whitelist) ──────────────────────────────────────────
// Each feature is a pure function of OHLCV → number[] aligned 1:1 with bars,
// NaN where the value isn't defined yet. `kind` documents the comparable
// scale so proposals (and humans) can reason about what compares with what.

function rocSeries(closes, period) {
  return closes.map((c, i) => {
    const prev = closes[i - period]
    return (i < period || !(prev > 0)) ? NaN : ((c - prev) / prev) * 100
  })
}

function atrSeries(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(NaN)
  if (closes.length < period + 1) return out
  const tr = [NaN]
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    ))
  }
  let atr = 0
  for (let i = 1; i <= period; i++) atr += tr[i]
  atr /= period
  out[period] = atr
  for (let i = period + 1; i < closes.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period
    out[i] = atr
  }
  return out
}

function volRatioSeries(volumes, period = 20) {
  const avg = smaSeries(volumes, period)
  return volumes.map((v, i) => (!avg[i] || isNaN(avg[i]) || avg[i] <= 0) ? NaN : v / avg[i])
}

/**
 * FEATURES — the complete vocabulary a proposal may reference.
 * `kind`: 'price' compares against other price-scale features; 'oscillator'
 * is 0–100; 'ratio' is unitless; 'pct' is a percentage.
 */
const FEATURES = {
  close:      { kind: 'price',      desc: 'closing price',                  fn: b => b.closes.slice() },
  open:       { kind: 'price',      desc: 'opening price',                  fn: b => b.opens.slice() },
  high:       { kind: 'price',      desc: 'session high',                   fn: b => b.highs.slice() },
  low:        { kind: 'price',      desc: 'session low',                    fn: b => b.lows.slice() },

  sma20:      { kind: 'price',      desc: '20-period simple moving average', fn: b => smaSeries(b.closes, 20) },
  sma50:      { kind: 'price',      desc: '50-period simple moving average', fn: b => smaSeries(b.closes, 50) },
  sma200:     { kind: 'price',      desc: '200-period simple moving average',fn: b => smaSeries(b.closes, 200) },
  ema9:       { kind: 'price',      desc: '9-period EMA',                    fn: b => computeEMAArray(b.closes, 9) },
  ema21:      { kind: 'price',      desc: '21-period EMA',                   fn: b => computeEMAArray(b.closes, 21) },
  ema50:      { kind: 'price',      desc: '50-period EMA',                   fn: b => computeEMAArray(b.closes, 50) },
  ema200:     { kind: 'price',      desc: '200-period EMA',                  fn: b => computeEMAArray(b.closes, 200) },

  rsi14:      { kind: 'oscillator', desc: 'RSI(14), 0-100',                  fn: b => rsiSeries(b.closes, 14) },
  rsi7:       { kind: 'oscillator', desc: 'RSI(7), 0-100 (faster)',          fn: b => rsiSeries(b.closes, 7) },
  bbPctB:     { kind: 'oscillator', desc: '%B position in Bollinger band, 0=lower 100=upper',
                fn: b => { const { upper, lower } = bbSeries(b.closes, 20, 2)
                           return b.closes.map((c, i) => (isNaN(upper[i]) || upper[i] === lower[i]) ? NaN : ((c - lower[i]) / (upper[i] - lower[i])) * 100) } },

  macd:       { kind: 'macd',       desc: 'MACD line (12,26)',               fn: b => macdSeries(b.closes).macd },
  macdSignal: { kind: 'macd',       desc: 'MACD signal line (9)',            fn: b => macdSeries(b.closes).signal },
  macdHist:   { kind: 'macd',       desc: 'MACD histogram (macd − signal)',  fn: b => macdSeries(b.closes).hist },

  bbUpper:    { kind: 'price',      desc: 'upper Bollinger band (20,2)',     fn: b => bbSeries(b.closes, 20, 2).upper },
  bbLower:    { kind: 'price',      desc: 'lower Bollinger band (20,2)',     fn: b => bbSeries(b.closes, 20, 2).lower },

  roc5:       { kind: 'pct',        desc: '5-bar rate of change %',          fn: b => rocSeries(b.closes, 5) },
  roc20:      { kind: 'pct',        desc: '20-bar rate of change %',         fn: b => rocSeries(b.closes, 20) },
  atrPct:     { kind: 'pct',        desc: 'ATR(14) as % of price (volatility)',
                fn: b => { const a = atrSeries(b.highs, b.lows, b.closes, 14)
                           return a.map((v, i) => (isNaN(v) || !(b.closes[i] > 0)) ? NaN : (v / b.closes[i]) * 100) } },
  volRatio:   { kind: 'ratio',      desc: 'volume ÷ 20-bar average volume',  fn: b => volRatioSeries(b.volumes, 20) },
}

const FEATURE_NAMES = Object.keys(FEATURES)

// ── Grammar ───────────────────────────────────────────────────────────────────
// Numeric node:  { feature: <name> } | { const: <number> }
// Boolean node:  { op: '<'|'>'|'<='|'>='|'cross_above'|'cross_below', left, right }  (numeric operands)
//                { op: 'and'|'or', left, right }   (boolean operands)
//                { op: 'not', operand }            (boolean operand)

const COMPARISON_OPS = ['<', '>', '<=', '>=', 'cross_above', 'cross_below']
const LOGIC_BINARY   = ['and', 'or']
const ALL_OPS        = [...COMPARISON_OPS, ...LOGIC_BINARY, 'not']

class RuleError extends Error {}

/**
 * Validate a node and return its type ('numeric' | 'boolean').
 * Throws RuleError with a precise reason — rejections are explained, never
 * silently coerced, so a malformed proposal is visibly discarded.
 */
function validateNode(node, depth = 1, counter = { n: 0 }) {
  if (depth > MAX_DEPTH) throw new RuleError(`rule nested deeper than ${MAX_DEPTH}`)
  if (++counter.n > MAX_NODES) throw new RuleError(`rule exceeds ${MAX_NODES} nodes`)
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new RuleError('node must be an object')

  if ('feature' in node) {
    if (!FEATURES[node.feature]) throw new RuleError(`unknown feature: ${JSON.stringify(node.feature)}`)
    return 'numeric'
  }
  if ('const' in node) {
    const v = node.const
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RuleError(`const must be a finite number, got ${JSON.stringify(v)}`)
    return 'numeric'
  }
  if (!('op' in node)) throw new RuleError('node must have "feature", "const" or "op"')

  const op = node.op
  if (!ALL_OPS.includes(op)) throw new RuleError(`unknown operator: ${JSON.stringify(op)}`)

  if (op === 'not') {
    const t = validateNode(node.operand, depth + 1, counter)
    if (t !== 'boolean') throw new RuleError('"not" requires a boolean operand')
    return 'boolean'
  }

  const lt = validateNode(node.left,  depth + 1, counter)
  const rt = validateNode(node.right, depth + 1, counter)

  if (COMPARISON_OPS.includes(op)) {
    if (lt !== 'numeric' || rt !== 'numeric') throw new RuleError(`"${op}" requires numeric operands`)
    return 'boolean'
  }
  // and / or
  if (lt !== 'boolean' || rt !== 'boolean') throw new RuleError(`"${op}" requires boolean operands`)
  return 'boolean'
}

/**
 * Validate a full rule { entry, exit }. Returns { ok, error }.
 * Both sides must be BOOLEAN expressions — a rule whose entry is a bare
 * number has no meaning and must not reach the interpreter.
 */
function validateRule(rule) {
  try {
    if (!rule || typeof rule !== 'object') throw new RuleError('rule must be an object')
    const counter = { n: 0 }
    if (validateNode(rule.entry, 1, counter) !== 'boolean') throw new RuleError('entry must be a boolean expression')
    if (validateNode(rule.exit,  1, counter) !== 'boolean') throw new RuleError('exit must be a boolean expression')
    return { ok: true, nodes: counter.n }
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message }
    return { ok: false, error: `invalid rule: ${e.message}` }
  }
}

// ── Interpreter (deterministic, vectorized, no code execution) ───────────────

function featureContext(bars) {
  const cache = {}
  return {
    length: bars.closes.length,
    get(name) {
      if (!(name in cache)) cache[name] = FEATURES[name].fn(bars)
      return cache[name]
    },
  }
}

/** Evaluate a numeric node → number[] (NaN where undefined). */
function evalNumeric(node, ctx) {
  if ('feature' in node) return ctx.get(node.feature)
  return new Array(ctx.length).fill(node.const)
}

/** Evaluate a boolean node → (true|false|null)[]; null = undecidable here. */
function evalBoolean(node, ctx) {
  const op = node.op
  const n  = ctx.length

  if (op === 'not') {
    const inner = evalBoolean(node.operand, ctx)
    return inner.map(v => (v === null ? null : !v))
  }

  if (LOGIC_BINARY.includes(op)) {
    const l = evalBoolean(node.left, ctx)
    const r = evalBoolean(node.right, ctx)
    return Array.from({ length: n }, (_, i) => {
      if (l[i] === null || r[i] === null) return null
      return op === 'and' ? (l[i] && r[i]) : (l[i] || r[i])
    })
  }

  const l = evalNumeric(node.left, ctx)
  const r = evalNumeric(node.right, ctx)
  return Array.from({ length: n }, (_, i) => {
    const a = l[i], b = r[i]
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null
    switch (op) {
      case '<':  return a <  b
      case '>':  return a >  b
      case '<=': return a <= b
      case '>=': return a >= b
      case 'cross_above': {
        const pa = l[i - 1], pb = r[i - 1]
        if (i === 0 || !Number.isFinite(pa) || !Number.isFinite(pb)) return null
        return pa <= pb && a > b
      }
      case 'cross_below': {
        const pa = l[i - 1], pb = r[i - 1]
        if (i === 0 || !Number.isFinite(pa) || !Number.isFinite(pb)) return null
        return pa >= pb && a < b
      }
      default: return null
    }
  })
}

/**
 * Compile a validated rule into a +1/-1/0 signal array for the backtest engine.
 *
 * EXIT TAKES PRECEDENCE when entry and exit are both true on the same bar —
 * the risk-off reading. A rule that says "get out" and "get in" simultaneously
 * is ambiguous, and resolving ambiguity toward flat is the safer default.
 *
 * @param {object} rule  — must already have passed validateRule()
 * @param {object} bars  — { opens, highs, lows, closes, volumes }
 */
function generateRuleSignals(rule, bars) {
  const v = validateRule(rule)
  if (!v.ok) throw new RuleError(v.error)

  const ctx   = featureContext(bars)
  const entry = evalBoolean(rule.entry, ctx)
  const exit  = evalBoolean(rule.exit,  ctx)

  return Array.from({ length: ctx.length }, (_, i) => {
    if (exit[i] === true)  return -1
    if (entry[i] === true) return 1
    return 0
  })
}

// ── Human-readable rendering (for prompts, the library and the UI) ──────────

function describeNode(node) {
  if ('feature' in node) return node.feature
  if ('const' in node)   return String(node.const)
  if (node.op === 'not') return `NOT(${describeNode(node.operand)})`
  const sym = { and: 'AND', or: 'OR', cross_above: 'crosses above', cross_below: 'crosses below' }[node.op] || node.op
  return `(${describeNode(node.left)} ${sym} ${describeNode(node.right)})`
}

/** One-line human description of a rule — used in library entries and logs. */
function describeRule(rule) {
  try { return `ENTRY ${describeNode(rule.entry)} | EXIT ${describeNode(rule.exit)}` }
  catch { return 'invalid rule' }
}

/** The feature vocabulary, rendered for the proposal prompt. */
function featureCatalogBlock() {
  const byKind = {}
  for (const [name, f] of Object.entries(FEATURES)) {
    (byKind[f.kind] ||= []).push(`${name} (${f.desc})`)
  }
  return Object.entries(byKind)
    .map(([kind, names]) => `  ${kind}: ${names.join(', ')}`)
    .join('\n')
}

/**
 * Prompt for composing NEW strategies from primitives. The model is told
 * plainly that its rule will be backtested and that invalid trees are
 * discarded — there is no value in it producing something clever-looking
 * that doesn't validate.
 */
function buildCompositionPrompt({ symbol, range, taLine, count = 3 }) {
  const n = Math.max(1, Math.min(count, 5))
  return `You are a systematic-trading quant COMPOSING NEW rule-based strategies for ${symbol} on daily bars over the last ${range}.

COMPUTED TECHNICALS (real measured data for this symbol — ground your rules in it):
${taLine || `${symbol}: no technical summary available`}

You compose strategies from these primitives. You may ONLY reference these feature names:
${featureCatalogBlock()}

Rule grammar (JSON only — this is a data structure, NOT code):
  numeric:  { "feature": "rsi14" }  or  { "const": 30 }
  compare:  { "op": "<" | ">" | "<=" | ">=" | "cross_above" | "cross_below", "left": <numeric>, "right": <numeric> }
  logic:    { "op": "and" | "or", "left": <boolean>, "right": <boolean> }  |  { "op": "not", "operand": <boolean> }

Each strategy is { "entry": <boolean>, "exit": <boolean> }: enter long when entry is true, close when exit is true.

Constraints (violations are DISCARDED, so respect them):
- compare only operands on the same scale: price-scale features with price-scale features (close, ema50, bbUpper…), oscillators with 0-100 constants (rsi14, bbPctB), macd with macd
- at most ${MAX_NODES} nodes and ${MAX_DEPTH} levels of nesting per strategy
- entry and exit must both be BOOLEAN expressions

Compose exactly ${n} DISTINCT strategies suited to THIS symbol's current character (trending vs ranging, volatility, momentum). Combine 2–3 conditions so each rule expresses a real thesis rather than a single threshold. Make them meaningfully different from each other.

IMPORTANT: every strategy will be validated by a real backtest engine on historical prices. Do NOT claim any performance numbers — state only WHY the composition fits the technicals above.

Respond ONLY with a JSON object — no markdown, no explanation:
{
  "strategies": [
    {
      "name": "short human-readable name (≤8 words)",
      "rule": { "entry": { ... }, "exit": { ... } },
      "rationale": "2 sentences: why this composition fits THIS symbol's measured technicals",
      "marketFit": "one line: the market condition this works best in"
    }
  ]
}`
}

/**
 * Parse + validate composed-strategy proposals. Invalid rules are dropped
 * with their reason; duplicates (same rule shape) are deduped.
 * Returns [{ name, rule, rationale, marketFit, description }].
 */
function parseCompositions(rawText, maxCount = 5) {
  const { tryParseAiJson } = require('./ai-json')
  const parsed = tryParseAiJson(rawText)
  const list = Array.isArray(parsed) ? parsed : parsed?.strategies
  if (!Array.isArray(list)) return { strategies: [], rejected: [] }

  const strategies = [], rejected = [], seen = new Set()
  for (const item of list) {
    if (strategies.length >= maxCount) break
    const rule = item?.rule
    const v = validateRule(rule)
    if (!v.ok) { rejected.push({ name: item?.name ?? null, reason: v.error }); continue }
    const key = JSON.stringify(rule)
    if (seen.has(key)) continue
    seen.add(key)
    strategies.push({
      name:        String(item.name || 'composed strategy').slice(0, 80),
      rule,
      rationale:   String(item.rationale || '').slice(0, 400),
      marketFit:   String(item.marketFit || '').slice(0, 200),
      description: describeRule(rule),
      nodes:       v.nodes,
    })
  }
  return { strategies, rejected }
}

module.exports = {
  FEATURES, FEATURE_NAMES, MAX_NODES, MAX_DEPTH, COMPARISON_OPS, LOGIC_BINARY, ALL_OPS,
  RuleError,
  validateNode, validateRule, generateRuleSignals,
  evalNumeric, evalBoolean, featureContext,
  describeRule, describeNode, featureCatalogBlock,
  buildCompositionPrompt, parseCompositions,
}
