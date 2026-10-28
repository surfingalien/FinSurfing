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
const { sizeIfCalibrated, RISK_BUDGET } = require('./kelly')
const { factorScores }   = require('./factor-model')
const { wilson }         = require('./calibration-stats')
const { tryParseAiJson } = require('./ai-json')
const { tradeLevels } = require('./trade-levels')
const { describe: describePriceRegime, ordinal } = require('./price-regime')
const { HOLD_DAYS: HOLD_DRIFT } = require('./pead')

const HORIZONS = [7, 30, 90]
const MAX_CLAIMS = 5
const OWN_NOTE_CHARS = 600   // the user's own note, as context in the prompt

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
  symbol, bars, taLine = null, fundamentals = null, macro = null, priceRegime = null,
  minedFactors = null, earningsDrift = null, reported = null, institutional = null, insiders = null, filingChange = null, strategies = null, exposure = null, track = null,
  ownNote = null,
}) {
  const items = []
  const gaps  = []
  const add = (kind, label, text, { measured = true, source, citable } = {}) => {
    items.push({ id: `E${items.length + 1}`, kind, label, text, measured, source, ...(citable === false ? { citable: false } : {}) })
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

  // Factors mined across a large-cap list (lib/factor-mining.js). Only for
  // stocks — the list is stocks, so a percentile for anything else is meaningless.
  if (minedFactors?.library) {
    const lib = minedFactors.library
    const runOn = String(lib.ranAt || '').slice(0, 10)
    const head = `across ${lib.universe} large caps, ${lib.horizon}-day horizon, run ${runOn}`
    add('mined-factors', 'Proven cross-sectional factors', minedFactors.ranks?.length
      ? `Price factors that ranked next-month returns beyond chance (${lib.admitted.length} of ${lib.tested} candidates admitted ${head}; walk-forward, corrected for the number tried): ` +
        minedFactors.ranks.map(f => `${f.label} — ${symbol} in the ${ordinal(f.percentile)} percentile (holdout IC ${sign(f.holdoutIc)} over ${f.holdoutPeriods} periods)`).join('; ') + '.'
      : lib.admitted.length
        ? `${lib.admitted.length} of ${lib.tested} price factors were admitted (${head}), but ${symbol}'s own history is too short to place it on them.`
        : `None of the ${lib.tested} price-factor candidates ranked next-month returns beyond chance (${head}); the factor scores above describe ${symbol}, they are not proven predictors.`,
      { source: 'lib/factor-mining.js' })
  } else if (minedFactors) {
    gaps.push('mined factors: no mining run yet')
  }

  // Post-earnings drift (lib/pead.js): this name's last report, where it is
  // in the 20-session window, and what the pooled study measured.
  if (earningsDrift?.event || earningsDrift?.sue) {
    const e = earningsDrift.event, w = earningsDrift.window, st = earningsDrift.study, su = earningsDrift.sue
    const groupWord = g => ({ beat: 'a beat', miss: 'a miss', inline: 'in line' }[g])
    const parts = [
      e && `Last report ${e.date}: EPS ${e.actual != null ? `$${e.actual}` : '?'} vs $${e.estimate ?? '?'} expected (${sign(e.surprisePct)}% surprise, ${groupWord(e.group)}).`,
      su && `Estimate-free surprise from SEC filings (quarter ended ${su.end}, filed ${su.filed}): EPS ${su.change >= 0 ? 'up' : 'down'} ${Math.abs(su.change)} on the same quarter a year earlier, SUE ${sign(su.sue)} (${groupWord(su.group)}${su.window ? (su.window.inWindow ? `, ${su.window.sessionsSince} of ${HOLD_DRIFT} sessions into its window` : ', window closed') : ''}).`,
      st?.sue?.strategy && `Estimate-free drift study: SUE beats averaged ${st.sue.groups?.beat?.n ? `${sign(st.sue.groups.beat.meanAbn)}% vs SPY over ${st.sue.groups.beat.n} events` : 'no measured events'}; verdict ${st.sue.strategy.verdict}.`,
      e?.toneChange != null ? `Call tone ${e.toneChange > 0 ? 'improved' : 'worsened'} from the previous call (word-count score ${sign(e.toneChange)}).` : null,
      e && w ? (w.inWindow ? `${w.sessionsSince} of ${HOLD_DRIFT} sessions into the post-earnings window.` : `The ${HOLD_DRIFT}-session post-earnings window has closed.`) : null,
      st?.strategy ? `Post-earnings drift study (${st.universe} large caps, ${st.events} events, entry the open after the report, net of costs): beats averaged ${st.groups?.beat?.n ? `${sign(st.groups.beat.meanAbn)}% vs SPY over ${st.groups.beat.n} events (month-clustered t=${st.groups.beat.t ?? 'n/a'})` : 'no measured events'}; verdict ${st.strategy.verdict}.` : 'No post-earnings drift study has run yet.',
    ].filter(Boolean)
    add('earnings-drift', 'Post-earnings drift', parts.join(' '), { source: 'lib/pead.js + FMP earnings' })
  }

  // Reported figures from the company's own SEC filings (lib/sec-facts.js) —
  // keyless, dated by filing, and present when the FMP quota is spent.
  if (reported) {
    const r = reported
    const big = v => { const a = Math.abs(v); const [d, u] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1, '']; return `${v < 0 ? '-' : ''}$${(a / d).toFixed(1)}${u}` }
    const parts = [
      r.revenueTtm != null && `trailing-four-quarter revenue ${big(r.revenueTtm)}${r.revenueGrowthYoY != null ? ` (${sign(r.revenueGrowthYoY)}% year over year)` : ''}`,
      r.netMargin != null && `net margin ${r.netMargin}%`,
      r.epsTtm != null && `diluted EPS $${r.epsTtm}${r.pe != null ? ` (P/E ${r.pe} at the last close)` : ''}`,
      r.fcfMargin != null && `free-cash-flow margin ${r.fcfMargin}%`,
      r.roe != null && `return on equity ${r.roe}%`,
      r.debtToEquity != null && `long-term debt/equity ${r.debtToEquity}`,
    ].filter(Boolean)
    if (parts.length) {
      add('reported', 'Reported financials (SEC)', `Reported in SEC filings (latest quarter ended ${r.periodEnd}, filed ${r.lastFiled}): ${parts.join('; ')}.`,
        { source: 'SEC XBRL company facts' })
    }
  }

  // Notable fund managers' 13F moves (lib/thirteenf.js). Their filings are
  // facts; whether the moves predict anything is not established here.
  if (institutional) add('institutional', 'Fund managers (13F)', institutional, { source: 'SEC 13F-HR filings' })
  if (insiders) add('insiders', 'Insider buying', insiders, { source: 'SEC Form 4 data sets (lib/insider-buys.js)' })
  if (filingChange) add('filing-change', 'Filing change', filingChange, { source: 'SEC 10-K/10-Q text (lib/filing-change.js)' })

  if (macro?.regime?.regime) {
    const sig = (macro.regime.signals || []).slice(0, 3).map(s => s.text).join('; ')
    const pb = macro.playbook
    const tilt = pb ? [pb.favor?.length && `favor ${pb.favor.slice(0, 3).join(', ')}`, pb.avoid?.length && `avoid ${pb.avoid.slice(0, 3).join(', ')}`].filter(Boolean).join('; ') : ''
    add('macro', 'Macro regime', `Macro regime (FRED): ${macro.regime.regime}.${sig ? ` Signals: ${sig}.` : ''}${tilt ? ` Playbook: ${tilt}.` : ''}`, { source: 'FRED' })
  } else {
    gaps.push(`macro: ${macro?.error || 'unavailable'}`)
  }

  if (priceRegime?.label) {
    const p = priceRegime.profile?.[priceRegime.label]
    add('price-regime', 'Market regime (prices)', `Market regime from prices — ${describePriceRegime(priceRegime, priceRegime.symbol)}` +
      (p?.n ? ` Historically after this state, ${priceRegime.symbol}'s next 20 ${priceRegime.symbol === 'BTC-USD' ? 'days' : 'trading days'} averaged ${sign(p.meanFwdRet)}% and were up ${Math.round(p.upShare * 100)}% of the time (${p.n} non-overlapping windows).` : ''),
      { source: 'lib/price-regime.js' })
  } else {
    gaps.push('price regime: benchmark bars unavailable')
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

  // The user's latest Second Brain note on the symbol: what they already think,
  // so the thesis can say where the evidence agrees or not. Context only —
  // auditClaims deletes any claim that cites it.
  if (ownNote?.title) {
    const when = String(ownNote.updated_at || ownNote.created_at || '').slice(0, 10)
    const body = String(ownNote.content || '').replace(/\s+/g, ' ').trim()
    add('own-note', 'Your own earlier note',
      `"${String(ownNote.title).trim()}"${when ? ` (${when})` : ''}${body ? `: ${body.slice(0, OWN_NOTE_CHARS)}${body.length > OWN_NOTE_CHARS ? '…' : ''}` : ''}`,
      { measured: false, citable: false, source: 'Second Brain' })
  }

  return { items, gaps, facts }
}

/** Concatenated text of the cited evidence items (unknown ids ignored). Pure. */
function evidenceText(items, ids) {
  const want = new Set(ids)
  return items.filter(i => want.has(i.id)).map(i => i.text).join('\n')
}

// ── 2. Thesis prompt + parsing ────────────────────────────────────────────────

// How an item is presented to the model. An uncitable item (the user's own
// note) is context: claims citing it are deleted by auditClaims, and the model
// is told so up front rather than discovering it.
function itemLine(i) {
  const tag = i.citable === false ? ' (the user\'s own earlier note — context only; never cite it)'
    : i.measured ? '' : ' (third-party opinion, not a measurement)'
  return `[${i.id}] ${i.label}${tag}: ${i.text}`
}

function buildThesisPrompt({ symbol, items, gaps = [] }) {
  const block = items.map(itemLine).join('\n')
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

// ── Debate mode: separate bull, bear and decision calls ──────────────────────
// TradingAgents runs bull and bear researchers as SEPARATE agents, then a
// manager who must get past both; a live multi-market benchmark found agent
// design moved results far more than the model did. One call writing both
// sides tends to give the side it already leans toward the stronger case.
// Here: the bull argues for, the bear sees the bull's claims and rebuts them,
// a decision call weighs both and may add NOTHING — then judgeThesis checks
// every claim exactly as it does for a single-call thesis. Whether this beats
// the single call is measured (journal `method`, learning-store meta.method).

function evidenceBlock({ items, gaps = [] }) {
  const block = items.map(itemLine).join('\n')
  return `EVIDENCE — the ONLY facts you may use. Each has an id.\n${block}\n${gaps.length ? `\nNOT AVAILABLE for this run (do not speculate about these): ${gaps.join('; ')}\n` : ''}`
}

const CITE_RULES = `RULES — your output is checked by code, and anything that fails is DELETED before a reader sees it:
- Every claim must cite the evidence ids it rests on, e.g. "cites": ["E2","E4"].
- Any figure in a claim must appear in the evidence it cites. Do not compute new figures, do not round creatively, do not bring in outside facts.`

const claimLines = claims => (claims || []).map((c, i) => `${i + 1}. ${c.claim} [${(c.cites || []).join(', ')}]`).join('\n') || '(none)'

function buildBullPrompt({ symbol, items, gaps = [] }) {
  return `You are the BULL researcher on ${symbol}. Make the strongest honest case FOR buying now — nothing else.

${evidenceBlock({ items, gaps })}
${CITE_RULES}
- If the evidence does not support buying, return an empty "bull" list. Declining is a legitimate answer.
- targetReturn and stopLoss are PERCENTAGES from the current price (12 means +12%, 7 means −7%). horizonDays must be one of ${HORIZONS.join(', ')}.
- invalidation: the observable event that would prove the bull case wrong.`
}

function buildBearPrompt({ symbol, items, gaps = [], bull = [] }) {
  return `You are the BEAR researcher on ${symbol}. The bull researcher argued:
${claimLines(bull)}

Make the strongest honest case AGAINST buying now. Where the evidence contradicts a bull claim, rebut it directly and cite what contradicts it.

${evidenceBlock({ items, gaps })}
${CITE_RULES}
- If you find no evidence against, return an empty "bear" list rather than inventing one.`
}

function buildDecisionPrompt({ symbol, bull = [], bear = [], targetReturn = null, stopLoss = null, horizonDays = null }) {
  return `You are the portfolio manager deciding on ${symbol}. Two researchers argued, each citing evidence that code will verify.

BULL:
${claimLines(bull)}
Proposed plan: target ${targetReturn ?? '—'}%, stop ${stopLoss ?? '—'}%, horizon ${horizonDays ?? '—'} days.

BEAR:
${claimLines(bear)}

Decide: stance "long" only if the bull case genuinely outweighs the bear case for buying NOW; otherwise "avoid". Write a two-sentence summary of why. Do not add claims, evidence or figures that are not in the arguments above.`
}

/** The debate's three outputs as one thesis, shaped like parseThesis(). Pure. */
function assembleDebate(bullOut, bearOut, decisionOut) {
  const b = bullOut && typeof bullOut === 'object' ? bullOut : {}
  const d = decisionOut && typeof decisionOut === 'object' ? decisionOut : {}
  const h = Number(b.horizonDays)
  return {
    stance:       String(d.stance || '').toLowerCase() === 'long' ? 'long' : 'avoid',
    summary:      typeof d.summary === 'string' ? d.summary.trim().slice(0, 600) : '',
    bull:         cleanClaims(b.bull),
    bear:         cleanClaims(bearOut?.bear),
    targetReturn: Number.isFinite(Number(b.targetReturn)) ? Number(b.targetReturn) : null,
    stopLoss:     Number.isFinite(Number(b.stopLoss)) ? Math.abs(Number(b.stopLoss)) : null,
    horizonDays:  HORIZONS.includes(h) ? h : 30,
    invalidation: typeof b.invalidation === 'string' ? b.invalidation.trim().slice(0, 300) : '',
  }
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
  const uncitable = new Set(items.filter(i => i.citable === false).map(i => i.id))
  const kept = [], dropped = []
  for (const c of claims) {
    const unknown = c.cites.filter(id => !known.has(id))
    if (!c.cites.length) { dropped.push({ ...c, reason: 'cites no evidence' }); continue }
    if (unknown.length)  { dropped.push({ ...c, reason: `cites evidence that does not exist: ${unknown.join(', ')}` }); continue }
    // The user's own note may hold unchecked AI text (Braindump, Deep Research…);
    // a claim resting on it would pass as "verified" without being measured.
    const context = c.cites.filter(id => uncitable.has(id))
    if (context.length)  { dropped.push({ ...c, reason: `cites the user's own note (${context.join(', ')}), which is context, not evidence` }); continue }
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
function judgeCore({ thesis, items, lastPrice, assetType, winProb, levels = null }) {
  const bull = auditClaims(thesis.bull, items)
  const bear = auditClaims(thesis.bear, items)
  const summaryCheck = thesis.summary ? verifyCitation(thesis.summary, items.filter(i => i.citable !== false).map(i => i.text).join('\n')) : null
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

  // Capped so a stop-out costs ≤1% and an average day moves ≤0.25% of the
  // portfolio (kelly.riskCaps) — size falls as the name gets more volatile.
  out.sizing = sizeIfCalibrated(winProb, {
    winFrac: ev.netWinFrac, lossFrac: ev.netLossFrac,
    riskBudget: RISK_BUDGET, volFrac: levels?.atr > 0 && lastPrice > 0 ? levels.atr / lastPrice : null,
  })
  out.calibrated = winProb.n > 0
  out.verdict = 'actionable'
  reasons.push(ev.reason)
  // With nothing measured, "clears the gate" means only that the payoff shape
  // works at an ASSUMED 50% — say so rather than let it read as evidence.
  if (!out.calibrated) reasons.push('passes on the payoff shape at an assumed 50% win rate — this system has no measured record yet, so no position size is suggested')
  return out
}

/**
 * judgeCore() plus a trade plan on EVERY outcome (lib/trade-levels.js): the
 * thesis's own levels when it produced valid ones, otherwise technical
 * reference levels from the bars — so a "no trade" still tells the reader
 * where a setup would start, where it fails, and where to book profit.
 * `levels` is levelInputs(bars): { atr, support, resistance }.
 */
function judgeThesis(args) {
  const out = judgeCore(args)
  const li = args.levels || {}
  const base = { price: args.lastPrice, atr: li.atr, support: li.support, resistance: li.resistance }
  out.tradePlan = out.zones
    ? tradeLevels({ ...base, targetReturn: out.zones.targetReturn, stopLoss: out.zones.stopLoss })
    : tradeLevels(base)
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
  buildBullPrompt, buildBearPrompt, buildDecisionPrompt, assembleDebate,
  auditClaims, judgeThesis,
  trackFor, thesisStatus,
}
