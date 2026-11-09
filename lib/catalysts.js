'use strict'
/**
 * lib/catalysts.js — the dated events that could move a stock over the next
 * few months, in one list.
 *
 *   earnings        the next report date from the earnings calendar
 *                   (Finnhub → FMP → Yahoo via /api/earnings/date); with no
 *                   calendar date, one ESTIMATED from the last 10-Q/10-K
 *                   filing + a quarter, and labelled as an estimate
 *   ex-dividend     a declared ex-date (FMP); else the next one ESTIMATED from
 *                   the spacing of the last ex-dates
 *   lock-up expiry  IPO date + 180 days, while it is still ahead
 *   options expiry  monthly (third Friday) and quarterly "quad witching"
 *   index rebalance S&P 500 quarterly rebalance, effective after the close of
 *                   the third Friday of Mar/Jun/Sep/Dec
 *
 * Market-calendar dates are computed, not fetched; exchange holidays are NOT
 * adjusted, which the label says. Every event carries `scheduled` (a published
 * date) or `estimated` (derived), and its source.
 *
 * What the system has MEASURED about catalysts is shown beside them: the AI
 * Brain's picks by distance to earnings (brain-learnings computeStats
 * `earningsWindowImpact`, Wilson intervals). Nothing here decides a trade.
 *
 * buildCatalysts / marketCalendar / earningsRecord are pure; gatherInputs does
 * the I/O. Tests: tests/catalysts.test.js
 */

const DAY = 86_400_000
const HORIZON_DAYS = 120
const LOCKUP_DAYS = 180
const QUARTER_DAYS = 91

const iso = d => new Date(d).toISOString().slice(0, 10)
const addDays = (isoDate, n) => iso(Date.parse(isoDate) + n * DAY)
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

/** Third Friday of a month (UTC), as YYYY-MM-DD. */
function thirdFriday(year, month0) {
  const first = new Date(Date.UTC(year, month0, 1))
  const firstFri = 1 + ((5 - first.getUTCDay() + 7) % 7)
  return iso(Date.UTC(year, month0, firstFri + 14))
}

/** Options expiries and S&P rebalances between `from` and `from + horizon` days. Pure. */
function marketCalendar(from, horizon = HORIZON_DAYS) {
  const to = addDays(from, horizon), out = []
  const start = new Date(from + 'T00:00:00Z')
  for (let k = 0; k < Math.ceil(horizon / 28) + 2; k++) {
    const y = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + k) / 12), m = (start.getUTCMonth() + k) % 12
    const d = thirdFriday(y, m)
    if (d < from || d > to) continue
    const quarterly = m % 3 === 2
    out.push({ date: d, kind: 'options-expiry', label: quarterly ? 'Quarterly options expiry (quad witching)' : 'Monthly options expiry', scheduled: true, source: 'exchange rule: third Friday (holidays not adjusted)' })
    if (quarterly) out.push({ date: d, kind: 'index-rebalance', label: 'S&P 500 quarterly rebalance (effective after the close)', scheduled: true, source: 'S&P rule: third Friday of Mar/Jun/Sep/Dec (holidays not adjusted)' })
  }
  return out
}

/** Next ex-dividend: a declared future one, else estimated from the spacing of recent ones. Pure. */
function nextExDividend(rows, today) {
  const dates = (rows || []).map(r => String(r.date || r.exDividendDate || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  const ahead = dates.find(d => d >= today)
  const row = ahead && rows.find(r => String(r.date || r.exDividendDate).slice(0, 10) === ahead)
  if (ahead) return { date: ahead, scheduled: true, amount: row?.dividend ?? row?.adjDividend ?? null }
  const past = dates.filter(d => d < today).slice(-5)
  if (past.length < 3) return null
  const gaps = past.slice(1).map((d, i) => daysBetween(past[i], d)).sort((a, b) => a - b)
  const gap = gaps[Math.floor(gaps.length / 2)]
  if (gap < 25 || gap > 400) return null
  let next = addDays(past.at(-1), gap)
  while (next < today) next = addDays(next, gap)
  // A dividend that should already have gone ex and did not may have been cut or suspended.
  const overdue = daysBetween(past.at(-1), today) > gap * 1.5
  return { date: next, scheduled: false, gapDays: gap, overdue }
}

/**
 * Every catalyst within the horizon, nearest first. Pure.
 * inputs: { today, earnings: {nextEarningsDate, epsEstimate, source}, lastFiled,
 *           dividends: [rows], ipoDate }
 */
function buildCatalysts({ today, earnings = null, lastFiled = null, dividends = null, ipoDate = null, horizon = HORIZON_DAYS } = {}) {
  const to = addDays(today, horizon), events = []
  const inRange = d => d && d >= today && d <= to

  const next = earnings?.nextEarningsDate ? String(earnings.nextEarningsDate).slice(0, 10) : null
  if (inRange(next)) {
    events.push({ date: next, kind: 'earnings', label: `Earnings report${earnings.epsEstimate ? ` (EPS estimate ${earnings.epsEstimate})` : ''}`, scheduled: true, source: `earnings calendar (${earnings.source || 'provider'})` })
  } else if (lastFiled && daysBetween(lastFiled, today) <= 200) {   // only from a recent filing; an old one would project noise
    let est = addDays(lastFiled, QUARTER_DAYS)
    while (est < today) est = addDays(est, QUARTER_DAYS)
    if (inRange(est)) events.push({ date: est, kind: 'earnings', label: 'Earnings report (estimated: last SEC filing + one quarter)', scheduled: false, source: 'SEC filing dates' })
  }

  const div = nextExDividend(dividends, today)
  if (div && inRange(div.date)) {
    events.push({
      date: div.date, kind: 'ex-dividend', scheduled: div.scheduled, source: 'FMP dividends',
      label: div.scheduled ? `Ex-dividend${div.amount != null ? ` ($${div.amount})` : ''}` : `Ex-dividend (estimated from a ${div.gapDays}-day cycle${div.overdue ? '; the last one is overdue — check for a cut' : ''})`,
    })
  }

  if (ipoDate) {
    const lock = addDays(String(ipoDate).slice(0, 10), LOCKUP_DAYS)
    if (inRange(lock)) events.push({ date: lock, kind: 'lockup', label: `IPO lock-up expiry (IPO ${String(ipoDate).slice(0, 10)} + ${LOCKUP_DAYS} days; the prospectus may set another date)`, scheduled: false, source: 'FMP profile IPO date' })
  }

  events.push(...marketCalendar(today, horizon))
  return events
    .map(e => ({ ...e, daysAway: daysBetween(today, e.date) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
}

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

/** The AI Brain's measured record by distance to earnings, as one sentence (or null). Pure. */
function earningsRecord(stats) {
  const w = stats?.earningsWindowImpact
  if (!w) return null
  const seg = (k, label) => {
    const s = w[k]
    if (!s?.n) return null
    const a = s.nBench ? `beat the benchmark ${pct(s.alphaWinRate)} (95% CI ${pct(s.alphaWinRateLo)}–${pct(s.alphaWinRateHi)}, n=${s.nBench})` : `won ${pct(s.winRate)} (n=${s.n})`
    return `${label} ${a}`
  }
  const parts = [seg('imminent', '≤7 days before earnings'), seg('upcoming', '8–21 days before'), seg('distant', 'further out')].filter(Boolean)
  return parts.length ? `The AI Brain's resolved picks by distance to earnings (${w.imminent?.horizon ?? w.distant?.horizon ?? '?'}-day outcomes): ${parts.join('; ')}.` : null
}

/** One evidence paragraph: the next events for a symbol, plus the measured record. Pure. */
function describe(events, symbol = 'The stock', record = null, { max = 6 } = {}) {
  const own = (events || []).filter(e => !['options-expiry', 'index-rebalance'].includes(e.kind))
  const market = (events || []).filter(e => e.kind === 'index-rebalance' || (e.kind === 'options-expiry' && /Quarterly/.test(e.label))).slice(0, 1)
  const shown = [...own, ...market].sort((a, b) => a.date.localeCompare(b.date)).slice(0, max)
  if (!shown.length) return null
  const line = shown.map(e => `${e.date} (${e.daysAway}d): ${e.label}${e.scheduled ? '' : ' [estimate]'}`).join('; ')
  return `Upcoming catalysts for ${symbol}: ${line}.${own.some(e => e.kind === 'earnings') ? '' : ' No earnings date found within the window.'}${record ? ` ${record}` : ''}`
}

/** Fetch the inputs for one symbol. Best-effort: any missing source just drops its events. */
async function gatherInputs(symbol, { headers = {}, lastFiled = null, timeoutMs = 10_000, fmpKey = process.env.FMP_API_KEY } = {}) {
  const port = process.env.PORT || 3001
  const sym = String(symbol).toUpperCase()
  const [earnings, dividends, profile] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/earnings/date?symbol=${encodeURIComponent(sym)}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
      .then(r => r.json()).then(d => (d?.error ? null : d)).catch(() => null),
    fmpKey ? require('./fmp').dividends(sym, { key: fmpKey, timeoutMs }).catch(() => null) : Promise.resolve(null),
    fmpKey ? require('./fmp').profile(sym, { key: fmpKey, timeoutMs }).catch(() => null) : Promise.resolve(null),
  ])
  return { earnings, dividends, ipoDate: profile?.ipoDate || null, lastFiled }
}

module.exports = { HORIZON_DAYS, LOCKUP_DAYS, thirdFriday, marketCalendar, nextExDividend, buildCatalysts, earningsRecord, describe, gatherInputs }
