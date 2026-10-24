'use strict'

/**
 * lib/ai-schemas.js — the output schemas the AI surfaces decode against.
 *
 * Each mirrors the JSON template already written in that surface's prompt
 * (the prompt keeps its template: it is where the word limits and field
 * meanings live, and removing it would change what the model writes). The
 * schema adds what prose cannot: the shape is enforced token by token.
 *
 * Bounds the schema language cannot express (0–100 scores, ≤4 sources,
 * percent-not-price) are stated in descriptions and still enforced by the
 * surface's own code. Keep every schema STATIC — see lib/output-schema.js.
 * Tests: tests/ai-schemas.test.js lints every entry of SCHEMAS.
 */

const { str, num, int, bool, oneOf, arr, obj, pattern } = require('./output-schema')

const SCORE = d => int(`${d} — 0 to 100`)
const PCT   = d => num(`${d} — a PERCENTAGE from entry (12 means 12%), never a price`)

// ── AI Brain scan (routes/ai-brain.js:SCAN_SYSTEM) ───────────────────────────
const SCAN_PICK = obj({
  rank:                int('1 = best'),
  symbol:              str('ticker exactly as listed in the Universe'),
  name:                str(),
  sector:              str(),
  type:                oneOf(['Stock', 'ETF', 'Crypto', 'Fund']),
  currentPrice:        num('the price given in the request'),
  compositeScore:      SCORE('weighted average of the five agent scores'),
  confidence:          oneOf(['High', 'Medium', 'Low']),
  agentVerdict:        oneOf(['Strong Buy', 'Buy', 'Moderate Buy', 'Avoid']),
  targetReturn:        PCT('expected gain; 0 for Avoid'),
  stopLoss:            PCT('maximum loss; 0 for Avoid'),
  entryZoneLow:        num('dollar price; 0 for Avoid'),
  entryZoneHigh:       num('dollar price; 0 for Avoid'),
  targetZoneLow:       num('dollar price; 0 for Avoid'),
  targetZoneHigh:      num('dollar price; 0 for Avoid'),
  stopZoneLow:         num('dollar price; 0 for Avoid'),
  stopZoneHigh:        num('dollar price; 0 for Avoid'),
  fundamentalScore:    SCORE('fundamental analyst'),
  technicalScore:      SCORE('technical analyst'),
  sentimentScore:      SCORE('sentiment analyst'),
  macroScore:          SCORE('macro economist'),
  riskScore:           SCORE('risk manager; higher = safer'),
  fundamentalAnalysis: str('≤20 words'),
  technicalAnalysis:   str('≤20 words'),
  sentimentAnalysis:   str('≤20 words'),
  macroAnalysis:       str('≤20 words'),
  riskNote:            str('≤20 words'),
  supervisorSynthesis: str('≤20 words'),
  agentConflict: obj({
    exists:  bool('true when any two agent scores differ by ≥25'),
    agents:  arr(str(), 'the two most-divergent agents; [] when none'),
    spread:  int('largest score gap, 0–100'),
    meaning: str('≤15 words'),
  }),
  thesisAssumptions:   arr(str('≤10 words'), 'three falsifiable assumptions'),
  volumeSignal:        oneOf(['Confirming', 'Weak', 'Diverging', 'Unknown']),
  highConviction:      bool(),
  catalyst:            str('≤10 words'),
  keyDrivers:          arr(str('≤4 words')),
  bearCase:            str('≤10 words'),
  thesisBreaker:       str('≤8 words'),
})

const SCAN_SCHEMA = obj({
  marketRegime:        str('≤5 words'),
  macroOutlook:        str('≤15 words'),
  agentConsensusTheme: str('≤12 words'),
  dataSource:          oneOf(['live', 'knowledge']),
  rankedStocks:        arr(SCAN_PICK, 'up to 20 picks, best first'),
  agentNotes: obj({
    fundamentalAnalyst: str('≤15 words'),
    technicalAnalyst:   str('≤15 words'),
    sentimentAnalyst:   str('≤15 words'),
    macroEconomist:     str('≤15 words'),
    riskManager:        str('≤15 words'),
  }),
})

// ── Advisory (routes/recommendations.js) ─────────────────────────────────────
const RECOMMENDATIONS_SCHEMA = obj({
  recommendations: arr(obj({
    symbol:          str('standard ticker, e.g. BTC-USD'),
    name:            str(),
    type:            oneOf(['Stock', 'ETF', 'Crypto', 'Fund']),
    period:          oneOf(['3m', '6m']),
    sector:          str(),
    targetReturn:    PCT('expected gain, 5–40'),
    stopLoss:        PCT('maximum loss, 5–15'),
    entryPrice:      num('dollar price'),
    takeProfitPrice: num('dollar price'),
    stopLossPrice:   num('dollar price'),
    risk:            oneOf(['Low', 'Medium', 'High']),
    thesis:          str('2–3 sentences'),
    catalyst:        str(),
    technicalSignal: str(),
    bearCase:        str('≤10 words'),
    thesisBreaker:   str('≤8 words'),
    sources:         arr(str('≤12 words — evidence actually shown above'), 'at most 4; [] when none'),
  })),
  marketOutlook: str('2 sentences'),
  keyRisks:      str('1 sentence'),
})

// ── Per-symbol trading analysis (routes/trading-analysis.js) ─────────────────
const TRADING_ANALYSIS_SCHEMA = obj({
  signal:             oneOf(['BUY', 'SELL', 'HOLD']),
  confidence:         int('0 to 100'),
  trend:              oneOf(['BULLISH', 'BEARISH', 'NEUTRAL']),
  entry:              num('dollar price'),
  entryZoneLow:       num('dollar price'),
  entryZoneHigh:      num('dollar price'),
  stopLoss:           num('dollar price'),
  takeProfit:         arr(num('dollar price'), 'two levels'),
  riskReward:         num(),
  timeHorizon:        oneOf(['scalp', 'swing', 'position']),
  bullishProbability: int('0 to 100'),
  bearishProbability: int('0 to 100'),
  indicators: obj({
    rsi:       str(),
    macd:      str(),
    ema:       str(),
    bollinger: str(),
    volume:    str(),
  }),
  catalyst:       str('≤10 words'),
  contradictions: arr(str()),
  patterns:       arr(str()),
  reasoning:      str('3–4 sentences weighing bull and bear cases'),
  risks:          arr(str()),
  disclaimer:     str(),
})

// ── Research Desk thesis (lib/research-desk.js:buildThesisPrompt) ────────────
// `cites` is constrained to the evidence-id FORMAT; whether the cited item
// supports the claim is judgeThesis's job, not the schema's.
const CLAIM = obj({
  claim: str('one sentence; any figure must appear in the cited evidence'),
  cites: arr(pattern('^E[0-9]{1,2}$', 'an evidence id such as E3'), 'at least one evidence id'),
})
const THESIS_SCHEMA = obj({
  stance:       oneOf(['long', 'avoid']),
  summary:      str('two sentences'),
  bull:         arr(CLAIM, 'at most 5'),
  bear:         arr(CLAIM, 'at most 5'),
  targetReturn: PCT('0 for avoid'),
  stopLoss:     PCT('0 for avoid'),
  horizonDays:  oneOf([7, 30, 90]),
  invalidation: str('the observable event that would prove the thesis wrong'),
})

// ── Research Desk debate (lib/research-desk.js:buildBullPrompt …) ────────────
const BULL_SCHEMA = obj({
  bull:         arr(CLAIM, 'at most 5; [] when the evidence does not support buying'),
  targetReturn: PCT('expected gain'),
  stopLoss:     PCT('maximum loss'),
  horizonDays:  oneOf([7, 30, 90]),
  invalidation: str('the observable event that would prove the bull case wrong'),
})
const BEAR_SCHEMA = obj({
  bear: arr(CLAIM, 'at most 5; [] when nothing in the evidence argues against'),
})
const DECISION_SCHEMA = obj({
  stance:  oneOf(['long', 'avoid']),
  summary: str('two sentences, no new claims or figures'),
})

// ── Factor proposals (lib/factor-dsl.js) ─────────────────────────────────────
// The expression is a JSON string, not a nested schema: the tree is recursive,
// and lib/factor-dsl.js:validateExpr is the gate either way.
const FACTOR_PROPOSALS_SCHEMA = obj({
  factors: arr(obj({
    name:       str('short snake_case name'),
    hypothesis: str('one sentence: why it should rank next-month returns'),
    expression: str('the expression tree as a JSON string'),
  }), 'up to 6'),
})

const SCHEMAS = {
  'ai-brain-scan':     SCAN_SCHEMA,
  'recommendations':   RECOMMENDATIONS_SCHEMA,
  'trading-analysis':  TRADING_ANALYSIS_SCHEMA,
  'research-thesis':   THESIS_SCHEMA,
  'research-bull':     BULL_SCHEMA,
  'research-bear':     BEAR_SCHEMA,
  'research-decision': DECISION_SCHEMA,
  'factor-proposals':  FACTOR_PROPOSALS_SCHEMA,
}

module.exports = { SCAN_SCHEMA, RECOMMENDATIONS_SCHEMA, TRADING_ANALYSIS_SCHEMA, THESIS_SCHEMA, BULL_SCHEMA, BEAR_SCHEMA, DECISION_SCHEMA, FACTOR_PROPOSALS_SCHEMA, SCHEMAS }
