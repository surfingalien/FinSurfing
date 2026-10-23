'use strict'

/**
 * lib/settled-memory.js — the per-symbol analysis remembers what HAPPENED, not
 * only what it said.
 *
 * trading-analysis injects the user's last few analyses of a symbol ("BUY @
 * $180, 72% confidence") so the model can note trend changes. That memory
 * recorded the call and never the outcome, so a model that was wrong three
 * times running saw three confident calls and repeated a fourth. TradingAgents
 * settles each past decision once its holding period passes and writes the
 * result into the memory the next run reads; this does the same, measured in
 * code: each prior call is settled against today's price (direction-aware —
 * a SELL is right when price fell), labelled as "so far" because the move is
 * unfinished, and HOLDs are not scored. The AI Brain's own resolved record on
 * the symbol (Wilson interval) rides along when it exists.
 *
 * Pure. Tests: tests/settled-memory.test.js
 */

const DAY = 86_400_000
const MIN_AGE_DAYS = 1   // a call made today has no outcome yet

/** Settle prior calls against the current price. Pure. */
function settleMemories(memories, currentPrice, now = Date.now()) {
  if (!(currentPrice > 0)) return []
  return (memories || []).map(m => {
    const price = Number(m.price)
    const at = new Date(m.created_at).getTime()
    const signal = String(m.signal || '').toUpperCase()
    const daysAgo = Number.isFinite(at) ? Math.floor((now - at) / DAY) : null
    if (!(price > 0) || daysAgo == null) return null
    const retPct = +(((currentPrice - price) / price) * 100).toFixed(1)
    let verdict = 'not scored'
    if (daysAgo < MIN_AGE_DAYS) verdict = 'too recent'
    else if (signal === 'BUY') verdict = retPct > 0 ? 'right so far' : 'wrong so far'
    else if (signal === 'SELL') verdict = retPct < 0 ? 'right so far' : 'wrong so far'
    return { date: new Date(at).toISOString().slice(0, 10), signal, confidence: m.confidence ?? null, price, retPct, daysAgo, verdict, summary: m.summary ?? null }
  }).filter(Boolean)
}

/**
 * The prompt block. `brainTrack` is research-desk.trackFor(...).symbol (or null).
 * Returns '' when there is nothing to say. Pure.
 */
function memoryBlock(symbol, settled, brainTrack = null, currentPrice = null) {
  if (!settled.length && !brainTrack) return ''
  const lines = settled.map(s => {
    const move = `${s.retPct > 0 ? '+' : ''}${s.retPct}% over ${s.daysAgo}d`
    return `• [${s.date}] ${s.signal || '—'} @ $${s.price}${s.confidence != null ? ` (${s.confidence}% conf)` : ''} → $${currentPrice} now, ${move} — ${s.verdict}${s.summary ? ` — "${String(s.summary).slice(0, 120)}"` : ''}`
  })
  const scored = settled.filter(s => /so far/.test(s.verdict))
  const right = scored.filter(s => s.verdict === 'right so far').length
  const tally = scored.length ? `\nYour directional calls on ${symbol}: ${right} of ${scored.length} right so far (measured against today's price; the moves are unfinished).` : ''
  const brain = brainTrack ? `\nAI Brain resolved record on ${symbol}: ${brainTrack.wins} of ${brainTrack.n} picks up at their horizon (95% interval ${Math.round(brainTrack.lo * 100)}–${Math.round(brainTrack.hi * 100)}%).` : ''
  const steer = scored.length && right < scored.length
    ? `\nWhere a past call was wrong, say what is different now before repeating it.`
    : ''
  return `PRIOR CALLS ON ${symbol}, SETTLED IN CODE (measured outcomes, not opinions):\n${lines.join('\n')}${tally}${brain}${steer}\n`
}

module.exports = { settleMemories, memoryBlock, MIN_AGE_DAYS }
