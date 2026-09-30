'use strict'

/**
 * lib/research-desk.js
 *
 * The research flow for ONE symbol, end to end, in one place:
 *
 *   1. EVIDENCE  — gathered and computed in code (price, technicals, factor
 *                  scores, fundamentals, analysts, macro regime, forward-proven
 *                  strategies, disclosed exposure, and this system's own track
 *                  record with intervals). Every item gets an id (E1, E2 …) and
 *                  says whether it was MEASURED or is a third-party opinion.
 *   2. THESIS    — the model writes bull and bear claims, each citing the ids
 *                  it rests on, plus a target, a stop, a horizon and what would
 *                  prove it wrong. It is told its claims will be checked.
 *   3. JUDGEMENT — deterministic, no model:
 *                  • each claim is verified against ONLY the evidence it cites
 *                    (lib/claim-support.js, scoped — the Advisory gate checks
 *                    against the whole block, so a figure from an unrelated
 *                    section can satisfy it; here it cannot)
 *                  • price levels are derived from the entry and the
 *                    percentages (lib/price-coherence.js), never trusted
 *                  • the trade must clear the EV gate at the SHRUNK win rate
 *                    (lib/expected-value.js + lib/kelly.js)
 *                  A thesis with no surviving bull claim is not a trade.
 *   4. TRACKING  — an actionable thesis is journalled and later scored by
 *                  which barrier price touched first (target / stop / time),
 *                  the same label the Brain's own picks get.
 *
 * Everything here is pure. routes/research-desk.js does the I/O.
 * Tests: tests/research-desk.test.js
 */

const { verifyCitation } = require('./claim-support')
const { coherentZones }  = require('./price-coherence')
const { evaluateTrade }  = require('./expected-value')
const { sizeIfCalibrated } = require('./kelly')
const { factorScores }   = require('./factor-model')
const { wilson }         = require('./calibration-stats')
const { tryParseAiJson } = require('./ai-json')

const HORIZONS = [7, 30, 90]
const MAX_CLAIMS = 5

const pct  = (v, dp = 1) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(dp))
const fmt  = v => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toPrecision(4))
const sign = v => (v > 0 ? '+' : '') + v

// ── 1. Evidence ───────────────────────────────────────────────────────────────

function retOver(closes, days) {
  const n = closes.length
  if (n <= days) return null
  const a = closes[n - 1 - days], b = closes[n - 1]
  return a > 0 ? ((b - a) / a) * 100 : null
}

/** Price facts from daily bars (ascending). Pure. */
function priceFacts(bars) {
  const closes = bars.map(b => b.c)
  const last = closes.at(-1)
  const year = bars.slice(-252)
  const hi = Math.max(...year.map(b => b.h ?? b.c))
  const lo = Math.min(...year.map(b => b.l ?? b.c))
  return {
    last,
    date: new Date(bars.at(-1).t).toISOString().slice(0, 10),
    ret1m: pct(retOver(closes, 21)),
    ret3m: pct(retOver(closes, 63)),
    ret1y: pct(retOver(closes, 251)),
    hi52: hi, lo52: lo,
    offHigh: pct(((hi - last) / hi) * 100),
  }
}

/**
 * Build the evidence list. Every input except `bars` is optional; a missing
 * source is reported in `gaps` rather than silently absent, so the reader can
 * tell "no red flags" from "never checked".
 *
 * @returns {{ items: object[], gaps: string[], facts: object }}
 */
function buildEvidence({
  symbol, bars, taLine = null, fundamentals = null, macro = null,
  strategies = null, exposure = null, track = null,
}) {
  const items = []
  const gaps  = []
  const add = (kind, label, text, { measured = true, source } = {}) => {
    items.push({ id: `E${items.length + 1}`, kind, label, text, measured, source })
  }

  const facts = priceFacts(bars)
  const r = (v, lbl) => (v == null ? null : `${lbl} ${sign(v)}%`)
  add('price', 'Price', [
    `${symbol} last close $${fmt(facts.last)} (${facts.date}).`,
    [r(facts.ret1m, '1-month'), r(facts.ret3m, '3-month'), r(facts.ret1y, '1-year')].filter(Boolean).join(', ') + '.',
    `52-week range $${fmt(facts.lo52)}–$${fmt(facts.hi52)}; ${facts.offHigh}% below the 52-week high.`,
  ].join(' '), { source: 'daily bars' })

  if (taLine) add('technicals', 'Technicals', taLine, { source: 'lib/technical-indicators.js' })
  else gaps.push('technicals: fewer than 30 bars')

  const pe = fundamentals?.valuation?.pe_ttm ?? null
  const fs = factorScores({ closes: bars.map(b => b.c), highs: bars.map(b => b.h ?? b.c), lows: bars.map(b => b.l ?? b.c), pe })
  if (fs?.composite != null) {
    const part = (k, lbl) => (fs[k] == null ? null : `${lbl} ${fs[k]}`)
    add('factors', 'Factor scores', `Factor scores (0-100, computed from price history${pe != null ? ' and P/E' : ''}): ` +
      [part('momentum', 'momentum'), part('trend', 'trend'), part('lowVol', 'low-volatility'), part('value', 'value'), part('composite', 'composite')].filter(Boolean).join(', ') + '.',
      { source: 'lib/factor-model.js' })
  }

  if (fundamentals && !fundamentals.error) {
    const v = fundamentals.valuation || {}
    const vals = [
      v.pe_ttm    != null && `P/E ${pct(v.pe_ttm)}`,
      v.ps_ttm    != null && `P/S ${pct(v.ps_ttm)}`,
      v.ev_ebitda != null && `EV/EBITDA ${pct(v.ev_ebitda)}`,
      v.fcf_yield != null && `FCF yield ${v.fcf_yield}%`,
      v.roe       != null && `ROE ${v.roe}%`,
      v.roic      != null && `ROIC ${v.roic}%`,
    ].filter(Boolean)
    if (vals.length) add('valuation', 'Valuation', `Valuation (trailing twelve months): ${vals.join(', ')}.`, { source: 'FMP key-metrics-ttm' })
    const g = [
      fundamentals.yoy_rev_growth != null && `revenue growth year over year ${sign(fundamentals.yoy_rev_growth)}%`,
      fundamentals.cashflow?.fcf_margin != null && `free-cash-flow margin ${fundamentals.cashflow.fcf_margin}%`,
      fundamentals.ttm_revenue_fmt && `trailing revenue ${fundamentals.ttm_revenue_fmt}`,
    ].filter(Boolean)
    if (g.length) add('growth', 'Growth & cash flow', `Growth and cash flow: ${g.join(', ')}.`, { source: 'FMP statements' })
    const a = fundamentals.analyst_dist
    const eps = (fundamentals.eps_surprises || []).filter(s => s.surprise_pct != null)
    const aParts = [
      a?.total && `analysts ${a.buy_pct}% buy, ${a.hold_pct}% hold, ${a.sell_pct}% sell (${a.total} ratings)`,
      eps.length && `EPS surprise over the last ${eps.length} quarters: ${eps.map(s => `${sign(s.surprise_pct)}%`).join(', ')}`,
    ].filter(Boolean)
    if (aParts.length) add('analysts', 'Analysts & earnings', `${aParts.join('; ')}.`, { measured: false, source: 'FMP (third-party opinion)' })
  } else {
    gaps.push(`fundamentals: ${fundamentals?.error || 'unavailable'}`)
  }

  if (macro?.regime?.regime) {
    const sig = (macro.regime.signals || []).slice(0, 3).map(s => s.text).join('; ')
    const pb = macro.playbook
    const tilt = pb ? [pb.favor?.length && `favor ${pb.favor.slice(0, 3).join(', ')}`, pb.avoid?.length && `avoid ${pb.avoid.slice(0, 3).join(', ')}`].filter(Boolean).join('; ') : ''
    add('macro', 'Macro regime', `Macro regime (FRED): ${macro.regime.regime}.${sig ? ` Signals: ${sig}.` : ''}${tilt ? ` Playbook: ${tilt}.` : ''}`, { source: 'FRED' })
  } else {
    gaps.push(`macro: ${macro?.error || 'unavailable'}`)
  }

  if (Array.isArray(strategies)) {
    const proven = strategies.filter(s => s.forwardPasses >= 1)
    add('strategies', 'Validated strategies', proven.length
      ? `Strategies on ${symbol} that passed on bars AFTER discovery: ` + proven.slice(0, 3).map(s =>
        `${s.strategy} (fitness ${s.fitness}, ${s.forwardPasses} forward pass${s.forwardPasses > 1 ? 'es' : ''}, last alpha ${s.lastAlpha != null ? `${sign(s.lastAlpha)}%` : 'n/a'})`).join('; ') + '.'
      : strategies.length
        ? `No rule-based strategy on ${symbol} has yet passed a forward re-test (${strategies.length} candidate${strategies.length === 1 ? '' : 's'} awaiting out-of-sample evidence).`
        : `No rule-based strategy has been validated on ${symbol}.`,
      { source: 'lib/strategy-library.js' })
  }

  if (Array.isArray(exposure) && exposure.length) {
    // Each edge arrives pre-phrased by the route ("TSM is a supplier of NVDA").
    // Only relation facts — never the filing quote, which is untrusted text.
    add('exposure', 'Disclosed relationships', `Relationships disclosed in SEC filings: ` + exposure.slice(0, 4).map(e =>
      `${e.text} (${e.form || 'filing'}${e.filedAt ? ` ${String(e.filedAt).slice(0, 7)}` : ''})`).join('; ') + '.',
      { source: 'lib/entity-graph.js (quote-verified)' })
  }

  if (track) {
    const parts = []
    if (track.symbol?.n) {
      parts.push(`on ${symbol} specifically: ${track.symbol.wins} of ${track.symbol.n} past picks were up at ${track.horizon} days (95% interval ${Math.round(track.symbol.lo * 100)}–${Math.round(track.symbol.hi * 100)}%)`)
    } else {
      parts.push(`no resolved past picks on ${symbol}`)
    }
    if (track.assetClass?.n) {
      parts.push(`${track.assetClassName} picks overall: ${track.assetClass.wins} of ${track.assetClass.n} up (95% interval ${Math.round(track.assetClass.lo * 100)}–${Math.round(track.assetClass.hi * 100)}%)`)
    }
    add('track', 'This system\'s track record', `This system's own track record — ${parts.join('; ')}.`, { source: 'data/ai-brain-predictions.jsonl' })
  }

  return { items, gaps, facts }
}

/** Concatenated text of the cited evidence items (unknown ids ignored). Pure. */
function evidenceText(items, ids) {
  const want = new Set(ids)
  return items.filter(i => want.has(i.id)).map(i => i.text).join('\n')
}

// ── 2. Thesis prompt + parsing ────────────────────────────────────────────────

function buildThesisPrompt({ symbol, items, gaps = [] }) {
  const block = items.map(i => `[${i.id}] ${i.label}${i.measured ? '' : ' (third-party opinion, not a measurement)'}: ${i.text}`).join('\n')
  return `You are an equity research analyst writing a short, falsifiable investment thesis on ${symbol}.

EVIDENCE — the ONLY facts you may use. Each has an id.
${block}
${gaps.length ? `\nNOT AVAILABLE for this run (do not speculate about these): ${gaps.join('; ')}\n` : ''}
RULES — your output is checked by code, and anything that fails is DELETED before a reader sees it:
- Every claim must cite the evidence ids it rests on, e.g. "cites": ["E2","E4"].
- Any figure in a claim must appear in the evidence it cites. Do not compute new figures, do not round creatively, do not bring in outside facts.
- Write a bear case as seriously as the bull case. A thesis that ignores contrary evidence is not a thesis.
- stance "long" only if the evidence genuinely supports buying now; otherwise "avoid". Declining is a legitimate answer.
- For "long": targetReturn and stopLoss are PERCENTAGES from the current price (e.g. 12 means +12%, 7 means −7%). horizonDays must be one of ${HORIZONS.join(', ')}.
- invalidation: the observable event that would prove the thesis wrong.

Return ONLY JSON:
{
  "stance": "long" | "avoid",
  "summary": "two sentences, no figures that are not in the evidence",
  "bull": [{ "claim": "...", "cites": ["E1"] }],
  "bear": [{ "claim": "...", "cites": ["E3"] }],
  "targetReturn": 0,
  "stopLoss": 0,
  "horizonDays": 30,
  "invalidation": "..."
}`
}

function cleanClaims(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(c => c && typeof c.claim === 'string' && c.claim.trim())
    .slice(0, MAX_CLAIMS)
    .map(c => ({
      claim: c.claim.trim().slice(0, 400),
      cites: (Array.isArray(c.cites) ? c.cites : []).map(x => String(x).trim().toUpperCase()).filter(x => /^E\d{1,2}$/.test(x)).slice(0, 4),
    }))
}

/** Parse + normalise the model's thesis. Returns null when unusable. Pure. */
function parseThesis(text) {
  const j = tryParseAiJson(String(text || ''))
  if (!j || typeof j !== 'object') return null
  const stance = String(j.stance || '').toLowerCase() === 'long' ? 'long' : 'avoid'
  const h = Number(j.horizonDays)
  return {
    stance,
    summary:      typeof j.summary === 'string' ? j.summary.trim().slice(0, 600) : '',
    bull:         cleanClaims(j.bull),
    bear:         cleanClaims(j.bear),
    targetReturn: Number.isFinite(Number(j.targetReturn)) ? Number(j.targetReturn) : null,
    stopLoss:     Number.isFinite(Number(j.stopLoss)) ? Math.abs(Number(j.stopLoss)) : null,
    horizonDays:  HORIZONS.includes(h) ? h : 30,
    invalidation: typeof j.invalidation === 'string' ? j.invalidation.trim().slice(0, 300) : '',
  }
}

// ── 3. Judgement ──────────────────────────────────────────────────────────────

/**
 * Verify each claim against ONLY the evidence it cites. Pure.
 * Returns { kept, dropped } — dropped claims carry the reason.
 */
function auditClaims(claims, items) {
  const known = new Set(items.map(i => i.id))
  const kept = [], dropped = []
  for (const c of claims) {
    const unknown = c.cites.filter(id => !known.has(id))
    if (!c.cites.length) { dropped.push({ ...c, reason: 'cites no evidence' }); continue }
    if (unknown.length)  { dropped.push({ ...c, reason: `cites evidence that does not exist: ${unknown.join(', ')}` }); continue }
    const check = verifyCitation(c.claim, evidenceText(items, c.cites))
    if (!check.ok) { dropped.push({ ...c, reason: check.reason, verdict: check.verdict }); continue }
    kept.push({ ...c, check: check.verdict })
  }
  return { kept, dropped }
}

/**
 * Turn a parsed thesis into a verdict. No model involved.
 *
 * @param {object} o
 * @param {object} o.thesis      parseThesis() output
 * @param {object[]} o.items     evidence items
 * @param {number} o.lastPrice   entry anchor
 * @param {string} o.assetType   stock | etf | crypto | fund
 * @param {{p:number, source:string}} o.winProb  shrunk calibrated win rate
 */
function judgeThesis({ thesis, items, lastPrice, assetType, winProb }) {
  const bull = auditClaims(thesis.bull, items)
  const bear = auditClaims(thesis.bear, items)
  const summaryCheck = thesis.summary ? verifyCitation(thesis.summary, items.map(i => i.text).join('\n')) : null
  const reasons = []

  const out = {
    stance: thesis.stance,
    summary: summaryCheck && !summaryCheck.ok ? null : thesis.summary,
    summaryRemoved: summaryCheck && !summaryCheck.ok ? summaryCheck.reason : null,
    bull: bull.kept, bear: bear.kept,
    droppedClaims: [...bull.dropped.map(c => ({ side: 'bull', ...c })), ...bear.dropped.map(c => ({ side: 'bear', ...c }))],
    invalidation: thesis.invalidation,
    horizonDays: thesis.horizonDays,
    zones: null, expectedValue: null, sizing: null,
    verdict: 'no-trade', reasons,
  }

  if (thesis.stance !== 'long') { reasons.push('the analyst declined to recommend a position'); return out }
  if (!bull.kept.length) { reasons.push('no bull claim survived verification against its cited evidence'); return out }

  const { pick, drop, repairs } = coherentZones(
    { targetReturn: thesis.targetReturn, stopLoss: thesis.stopLoss, currentPrice: lastPrice },
    { livePrice: lastPrice },
  )
  if (drop) { reasons.push(`levels rejected: ${drop}`); return out }
  out.zones = {
    entryLow: pick.entryZoneLow, entryHigh: pick.entryZoneHigh,
    targetLow: pick.targetZoneLow, targetHigh: pick.targetZoneHigh,
    stopLow: pick.stopZoneLow, stopHigh: pick.stopZoneHigh,
    target: +(lastPrice * (1 + thesis.targetReturn / 100)).toFixed(4),
    stop:   +(lastPrice * (1 - thesis.stopLoss / 100)).toFixed(4),
    targetReturn: thesis.targetReturn, stopLoss: thesis.stopLoss,
    repairs: repairs.filter(r => !/^entry anchored/.test(r)),
  }

  const ev = evaluateTrade({ winProb: winProb.p, targetReturn: thesis.targetReturn, stopLoss: thesis.stopLoss, assetType })
  if (!ev) { reasons.push('target/stop could not be scored'); return out }
  out.expectedValue = { ...ev, winProbSource: winProb.source }
  if (!ev.actionable) { reasons.push(`expected-value gate: ${ev.reason}`); return out }

  out.sizing = sizeIfCalibrated(winProb, { winFrac: ev.netWinFrac, lossFrac: ev.netLossFrac })
  out.calibrated = winProb.n > 0
  out.verdict = 'actionable'
  reasons.push(ev.reason)
  // With nothing measured, "clears the gate" means only that the payoff shape
  // works at an ASSUMED 50% — say so rather than let it read as evidence.
  if (!out.calibrated) reasons.push('passes on the payoff shape at an assumed 50% win rate — this system has no measured record yet, so no position size is suggested')
  return out
}

// ── Track record helpers ──────────────────────────────────────────────────────

/**
 * This system's record on a symbol and its asset class, from resolved Brain
 * predictions, at one horizon. Counts + Wilson intervals. Pure.
 */
function trackFor(records, { symbol, assetType, horizon = 30 }) {
  const key = horizon === 30 ? 'price30d' : 'price7d'
  const at = r => (r.assetType === 'equity' ? 'stock' : r.assetType)
  const summarize = rows => {
    const scored = rows.map(r => {
      const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
      return base > 0 && r[key] != null ? r[key] > base : null
    }).filter(v => v !== null)
    if (!scored.length) return null
    const wins = scored.filter(Boolean).length
    return { n: scored.length, wins, ...wilson(wins, scored.length) }
  }
  const resolved = (records || []).filter(r => r[key] != null && r.entered !== false)
  return {
    horizon,
    symbol:     summarize(resolved.filter(r => String(r.symbol).toUpperCase() === symbol)),
    assetClass: summarize(resolved.filter(r => at(r) === assetType)),
    assetClassName: assetType,
  }
}

// ── 4. Tracking ───────────────────────────────────────────────────────────────

/**
 * Where an actionable thesis stands against real bars. Uses the same
 * first-touch rule as the Brain's triple barrier (both inside one bar ⇒ stop).
 * Pure; bars are [{t(ms), h, l, c}] ascending.
 */
function thesisStatus(entry, bars, { now = Date.now() } = {}) {
  const z = entry?.judgement?.zones
  if (entry?.judgement?.verdict !== 'actionable' || !z) return { state: 'no-trade' }
  const from = new Date(entry.at).getTime()
  const to   = from + entry.judgement.horizonDays * 86400000
  const window = (bars || []).filter(b => b.t > from && b.t <= Math.min(to, now))
  const anchor = entry.lastPrice
  const last = window.at(-1)?.c ?? null
  const retPct = last != null && anchor > 0 ? pct(((last - anchor) / anchor) * 100, 2) : null
  for (const b of window) {
    const hitStop   = (b.l ?? b.c) <= z.stop
    const hitTarget = (b.h ?? b.c) >= z.target
    const days = Math.round((b.t - from) / 86400000)
    if (hitStop)   return { state: 'stopped', days, retPct: pct(-z.stopLoss, 2), lastPrice: last }
    if (hitTarget) return { state: 'target-hit', days, retPct: pct(z.targetReturn, 2), lastPrice: last }
  }
  if (now >= to) return { state: window.length ? 'expired' : 'no-data', retPct, lastPrice: last }
  return { state: 'open', daysLeft: Math.ceil((to - now) / 86400000), retPct, lastPrice: last }
}

module.exports = {
  HORIZONS,
  priceFacts, buildEvidence, evidenceText,
  buildThesisPrompt, parseThesis,
  auditClaims, judgeThesis,
  trackFor, thesisStatus,
}
