'use strict'
/**
 * lib/strategy-lab.js
 *
 * Strategy Lab — LLM-proposed strategies validated by the real backtest engine.
 *
 * The model's role is strictly generative: it picks a strategy type + exact
 * params from the fixed STRATEGY_CATALOG below, with a rationale grounded in
 * the symbol's computed technicals. Every performance number in the response
 * comes from utils/backtest.js simulate() over real historical bars — a
 * fabricated metric can never reach the client because the model never
 * produces one.
 *
 * Pure logic (catalog, prompt builder, proposal parsing/clamping, verdicts,
 * evaluation) lives here so it's unit-testable; routes/strategy-lab.js does
 * the I/O. Tests: tests/strategy-lab.test.js.
 */

const { simulate } = require('../utils/backtest')
const { tryParseAiJson } = require('./ai-json')

// The full vocabulary the LLM may propose from. Unknown strategies are
// dropped; out-of-range params are clamped; missing params take defaults.
// `ordered` lists params that must be strictly increasing (fast < slow).
const STRATEGY_CATALOG = {
  sma_crossover: {
    description: 'buy when fast SMA crosses above slow SMA, sell on death cross',
    params: {
      fastPeriod: { min: 2, max: 100, int: true, default: 20 },
      slowPeriod: { min: 5, max: 250, int: true, default: 50 },
    },
    ordered: ['fastPeriod', 'slowPeriod'],
  },
  rsi_threshold: {
    description: 'buy on recovery from oversold RSI, sell when RSI crosses overbought',
    params: {
      period:     { min: 2,  max: 50, int: true, default: 14 },
      oversold:   { min: 5,  max: 45, int: true, default: 30 },
      overbought: { min: 55, max: 95, int: true, default: 70 },
    },
  },
  macd_signal: {
    description: 'buy when MACD line crosses above its signal line, sell on cross below',
    params: {
      fast:   { min: 2, max: 50,  int: true, default: 12 },
      slow:   { min: 5, max: 100, int: true, default: 26 },
      signal: { min: 2, max: 50,  int: true, default: 9 },
    },
    ordered: ['fast', 'slow'],
  },
  bb_reversion: {
    description: 'buy at lower Bollinger band touch, sell at upper band touch',
    params: {
      period: { min: 5,   max: 100, int: true,  default: 20 },
      mult:   { min: 0.5, max: 4,   int: false, default: 2 },
    },
  },
}

const MAX_PROPOSALS = 5

// ── Prompt ────────────────────────────────────────────────────────────────────

function catalogBlock() {
  return Object.entries(STRATEGY_CATALOG).map(([name, def]) => {
    const params = Object.entries(def.params)
      .map(([k, p]) => `${k}: ${p.min}–${p.max}${p.int ? ' (integer)' : ''}`)
      .join(', ')
    return `- ${name} — ${def.description}. Params: ${params}`
  }).join('\n')
}

/**
 * Build the proposal prompt. `taLine` is the compactTaLine() summary of the
 * symbol's real computed technicals (may be null for thin history).
 */
function buildProposalPrompt({ symbol, range, taLine, count = 3 }) {
  const n = Math.max(1, Math.min(count, MAX_PROPOSALS))
  return `You are a systematic-trading quant designing rule-based strategies for ${symbol} on daily bars over the last ${range}.

COMPUTED TECHNICALS (real data — ground your choices in this):
${taLine || `${symbol}: no technical summary available`}

Available strategy types (you may ONLY use these, with params inside the stated ranges):
${catalogBlock()}

Propose exactly ${n} DISTINCT strategy configurations suited to this symbol's current character (trending vs ranging, volatility, momentum). Vary the strategy type and/or params meaningfully — no near-duplicates.

IMPORTANT: every proposal will be validated by a real backtest engine against historical prices. Do NOT claim any performance numbers — state only WHY the configuration fits the technicals above.

Respond ONLY with a JSON object — no markdown, no explanation:
{
  "proposals": [
    {
      "strategy": "sma_crossover" | "rsi_threshold" | "macd_signal" | "bb_reversion",
      "params": { /* exact numeric params for that strategy */ },
      "name": "short human-readable name (≤8 words)",
      "rationale": "2 sentences: why these params fit THIS symbol's technicals (cite the data above)",
      "marketFit": "one line: the market condition this works best in"
    }
  ]
}`
}

// ── Parsing & validation ──────────────────────────────────────────────────────

function clampParam(value, spec) {
  let v = Number(value)
  if (!Number.isFinite(v)) v = spec.default
  v = Math.max(spec.min, Math.min(spec.max, v))
  return spec.int ? Math.round(v) : v
}

/**
 * Parse the LLM's raw text into clean, catalog-valid proposals.
 * - unknown strategy types are dropped
 * - params are coerced/clamped to catalog ranges, defaults fill gaps
 * - inverted ordered params (fast > slow) are swapped; equal → dropped
 * - duplicates (same strategy + params) are deduped
 * Returns [] when nothing valid survives (caller treats as an upstream error).
 */
function parseProposals(rawText, maxCount = MAX_PROPOSALS) {
  const parsed = tryParseAiJson(rawText)
  const list = Array.isArray(parsed) ? parsed : parsed?.proposals
  if (!Array.isArray(list)) return []

  const out  = []
  const seen = new Set()
  for (const p of list) {
    if (out.length >= maxCount) break
    const def = STRATEGY_CATALOG[p?.strategy]
    if (!def) continue

    const params = {}
    for (const [key, spec] of Object.entries(def.params)) {
      params[key] = clampParam(p.params?.[key], spec)
    }

    if (def.ordered) {
      const [a, b] = def.ordered
      if (params[a] > params[b]) [params[a], params[b]] = [params[b], params[a]]
      if (params[a] === params[b]) continue // degenerate crossover — never signals
    }

    const key = p.strategy + JSON.stringify(params)
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      strategy:  p.strategy,
      params,
      name:      String(p.name || `${p.strategy} variant`).slice(0, 80),
      rationale: String(p.rationale || '').slice(0, 400),
      marketFit: String(p.marketFit || '').slice(0, 200),
    })
  }
  return out
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Verdict from REAL backtest metrics — deterministic, never from the LLM.
 *   validated          — beat buy & hold AND positive risk-adjusted return
 *   mixed              — one of the two
 *   rejected           — neither
 *   insufficient_trades — fewer than 2 closed trades: metrics not meaningful
 */
function verdictFor(metrics) {
  if (!metrics || metrics.totalTrades < 2) return 'insufficient_trades'
  const beatMarket = metrics.alpha > 0
  const positiveRiskAdj = metrics.sharpeRatio > 0
  if (beatMarket && positiveRiskAdj) return 'validated'
  if (beatMarket || positiveRiskAdj) return 'mixed'
  return 'rejected'
}

const VERDICT_ORDER = { validated: 0, mixed: 1, insufficient_trades: 2, rejected: 3 }

const RECENT_KEYS = ['totalReturn', 'buyHoldReturn', 'alpha', 'sharpeRatio', 'maxDrawdown', 'totalTrades']

/**
 * Run every proposal through the real backtest engine.
 * Full-range metrics drive the verdict; a recent-window re-run (last ~40% of
 * bars, when ≥100 bars exist) is reported alongside as a cheap robustness
 * check — a strategy that only worked in the older half of the data shows a
 * full/recent divergence here.
 * Returns proposals sorted best-first (verdict, then Sharpe).
 */
function evaluateProposals(proposals, timestamps, closes, initialCapital = 10000) {
  const n = closes.length
  const recentStart = n >= 100 ? Math.floor(n * 0.6) : null

  const evaluated = proposals.map(p => {
    let metrics = null
    let recent  = null
    try {
      metrics = simulate(timestamps, closes, p.strategy, p.params, initialCapital).metrics
      if (recentStart != null) {
        const rm = simulate(timestamps.slice(recentStart), closes.slice(recentStart), p.strategy, p.params, initialCapital).metrics
        recent = Object.fromEntries(RECENT_KEYS.map(k => [k, rm[k]]))
      }
    } catch (_) { /* verdict falls through to insufficient_trades */ }
    return { ...p, metrics, recent, verdict: verdictFor(metrics) }
  })

  evaluated.sort((a, b) =>
    (VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]) ||
    ((b.metrics?.sharpeRatio ?? -Infinity) - (a.metrics?.sharpeRatio ?? -Infinity))
  )
  return evaluated
}

module.exports = {
  STRATEGY_CATALOG,
  MAX_PROPOSALS,
  buildProposalPrompt,
  parseProposals,
  verdictFor,
  evaluateProposals,
}
