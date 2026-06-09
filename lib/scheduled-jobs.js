'use strict'

/**
 * lib/scheduled-jobs.js
 *
 * Registers built-in scheduled jobs.
 * Call init() once after the server is listening.
 *
 * Jobs:
 *   morning-brief-email  — daily 9:30 AM ET Mon–Fri — AI brain scan + email
 *   pre-market-scan      — daily 8:30 AM server time — AI Brain broad scan
 *   earnings-watch       — daily 7:00 AM server time — upcoming earnings next 5 days
 *   macro-pulse          — hourly :00                — FRED macro refresh
 *   hourly-ai-scan       — hourly :05 Mon–Fri        — AI Brain broad scan cached for UI
 *   watchlist-digest     — daily 8:00 AM ET Mon–Fri  — analyze each watchlist symbol
 *   alt-data-refresh     — daily 6:30 AM server time — SEC Form 4 + FINRA short interest cache
 */

const scheduler  = require('./scheduler')
const { sendEmail } = require('./email')
const { getAltDataSnippet } = require('./alt-data')
const { resolveOutcomes, runMetaAnalysis } = require('./brain-learnings')
const { runScheduledFocus } = require('../routes/market-focus')

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

async function internalGet(path, timeoutMs = 30_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-internal': '1' },
  })
  if (!r.ok) throw new Error(`Internal fetch ${path} → HTTP ${r.status}`)
  return r.json()
}

async function internalPost(path, body, timeoutMs = 60_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal': '1' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Internal POST ${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

// ── Email template ────────────────────────────────────────────────────────────

function buildMorningBriefHtml({ stocks, brainData, macroData }) {
  const regime      = macroData?.regime ?? {}
  const regimeLabel = regime.regime ?? brainData?.marketRegime ?? 'N/A'
  const colorMap    = { red: '#ef4444', amber: '#f59e0b', emerald: '#10b981', slate: '#64748b' }
  const rc          = colorMap[regime.regimeColor] ?? '#64748b'
  const macroOutlook = brainData?.macroOutlook ?? ''
  const agentTheme   = brainData?.agentConsensusTheme ?? ''
  const signals      = (regime.signals ?? []).slice(0, 5)

  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  const verdictColor = v => {
    if (!v) return '#f59e0b'
    if (v.includes('Strong Buy')) return '#10b981'
    if (v.includes('Buy')) return '#22c55e'
    if (v.includes('Sell')) return '#ef4444'
    return '#f59e0b'
  }
  const scoreColor = s => s >= 75 ? '#10b981' : s >= 55 ? '#22c55e' : s >= 40 ? '#f59e0b' : '#ef4444'
  const fmt$ = n => n != null ? `$${Number(n).toFixed(2)}` : '—'

  // Each stock gets two rows: main data + thesis
  const rows = stocks.map((s, i) => {
    const bg = i % 2 === 0 ? '#f8fafc' : '#f1f5f9'
    const entryZone = (s.entryZoneLow && s.entryZoneHigh)
      ? `${fmt$(s.entryZoneLow)} – ${fmt$(s.entryZoneHigh)}`
      : (s.currentPrice ? fmt$(s.currentPrice) : '—')
    const thesis = s.supervisorSynthesis || (s.keyDrivers ?? []).join(' · ') || '—'
    const bearCase = s.bearCase ?? '—'
    return `
    <tr style="background:${bg};">
      <td style="padding:9px 5px 3px;text-align:center;color:#94a3b8;font-size:11px;vertical-align:top;">${s.rank}</td>
      <td style="padding:9px 5px 3px;vertical-align:top;">
        <div style="font-weight:700;color:#0f172a;font-size:13px;">${s.symbol}</div>
        <div style="color:#64748b;font-size:10px;margin-top:1px;">${s.sector ?? s.type ?? ''}</div>
      </td>
      <td style="padding:9px 5px 3px;color:#334155;font-size:11px;vertical-align:top;">${(s.name ?? '').slice(0, 20)}</td>
      <td style="padding:9px 5px 3px;text-align:center;vertical-align:top;">
        <span style="background:${verdictColor(s.agentVerdict)}18;color:${verdictColor(s.agentVerdict)};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap;">${s.agentVerdict ?? 'Buy'}</span>
      </td>
      <td style="padding:9px 5px 3px;text-align:center;font-weight:700;color:${scoreColor(s.compositeScore)};font-size:13px;vertical-align:top;">${Math.round(s.compositeScore ?? 0)}</td>
      <td style="padding:9px 5px 3px;text-align:center;vertical-align:top;">
        <div style="color:#10b981;font-weight:600;font-size:12px;">+${(s.targetReturn ?? 0).toFixed(1)}%</div>
        <div style="color:#64748b;font-size:9px;margin-top:1px;">6-month</div>
      </td>
      <td style="padding:9px 5px 3px;text-align:center;vertical-align:top;">
        <div style="color:#ef4444;font-size:11px;">${(s.stopLoss ?? 0).toFixed(1)}%</div>
        <div style="color:#94a3b8;font-size:9px;margin-top:1px;">${entryZone}</div>
      </td>
    </tr>
    <tr style="background:${bg};border-bottom:1px solid #e2e8f0;">
      <td></td>
      <td colspan="6" style="padding:0 5px 9px;">
        <span style="color:#475569;font-size:10px;">${thesis}</span>
        <span style="color:#ef4444;font-size:10px;margin-left:8px;">Bear: ${bearCase}</span>
      </td>
    </tr>`
  }).join('')

  const signalRows = signals.map(sig => {
    const icon = sig.type === 'warning' ? '⚠️' : sig.type === 'caution' ? '⚡' : '✅'
    return `<tr><td style="padding:4px 0;vertical-align:top;font-size:12px;">${icon}</td><td style="padding:4px 8px;color:#334155;font-size:12px;">${sig.text}</td></tr>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 0;">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0" style="max-width:660px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">

  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:28px 32px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="color:#00ffcc;font-size:22px;font-weight:800;letter-spacing:-.5px;">FinSurf</div>
          <div style="color:#94a3b8;font-size:12px;margin-top:2px;">3–6 Month Investment Picks · ${dateStr}</div>
        </td>
        <td align="right">
          <span style="background:${rc}22;color:${rc};border:1px solid ${rc}44;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;">${regimeLabel}</span>
        </td>
      </tr>
      ${macroOutlook ? `<tr><td colspan="2" style="padding-top:14px;color:#94a3b8;font-size:12px;border-top:1px solid #2d3f55;margin-top:14px;"><span style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Macro · </span>${macroOutlook}</td></tr>` : ''}
      ${agentTheme   ? `<tr><td colspan="2" style="padding-top:6px;color:#94a3b8;font-size:12px;"><span style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em;">AI Consensus · </span>${agentTheme}</td></tr>` : ''}
    </table>
  </td></tr>

  ${signalRows ? `
  <tr><td style="padding:16px 32px 4px;">
    <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Macro Signals</div>
    <table cellpadding="0" cellspacing="0">${signalRows}</table>
  </td></tr>
  <tr><td style="padding:12px 32px 0;"><div style="height:1px;background:#e2e8f0;"></div></td></tr>` : ''}

  <tr><td style="padding:16px 32px 10px;">
    <div style="font-size:11px;font-weight:700;color:#0f172a;">Top ${stocks.length} Stocks to Invest — 3 to 6 Month Horizon</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:3px;">AI-ranked across 20 candidates · fundamental · technical · sentiment · macro · risk</div>
  </td></tr>

  <tr><td style="padding:0 14px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead><tr style="background:#0f172a;">
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">#</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Ticker</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Name</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Conviction</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Score</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Target</th>
        <th style="padding:7px 4px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Stop / Entry</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </td></tr>

  <tr><td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:10px;line-height:1.6;">
      Sent automatically by FinSurf AI at 9:30 AM ET, Mon–Fri. Scans 20 diversified candidates and selects the top 10 by composite AI score.
      <strong>Not investment advice.</strong> Past performance does not guarantee future results. Always do your own research.
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function morningBriefEmail() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }
  const recipient = process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL
  if (!recipient) return { skipped: true, reason: 'MORNING_BRIEF_EMAIL or ADMIN_EMAIL not set' }

  const [macroResult, brainResult] = await Promise.allSettled([
    internalGet('/api/macro/indicators', 30_000),
    internalPost('/api/ai-brain/analyze', {
      // 20 diversified candidates across sectors — AI ranks and we email the top 10
      symbols: [
        'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','AMD',  // Tech
        'JPM','BAC','GS','BRK-B',                                  // Finance
        'LLY','UNH','ABBV',                                        // Healthcare
        'XOM','CVX',                                               // Energy
        'WMT','COST','CAT',                                        // Consumer / Industrial
      ],
      horizon: '6m',
    }, 300_000),
  ])

  const macroData = macroResult.status === 'fulfilled' ? macroResult.value : null
  if (brainResult.status === 'rejected')
    throw new Error(`AI Brain analyze failed: ${brainResult.reason?.message ?? brainResult.reason}`)
  const brainData = brainResult.value
  if (!brainData) throw new Error('AI Brain analyze returned empty response')

  const stocks = (brainData.rankedStocks ?? []).slice(0, 10)
  const html   = buildMorningBriefHtml({ stocks, brainData, macroData })

  const regimeLabel = macroData?.regime?.regime ?? brainData?.marketRegime ?? 'N/A'
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  })

  await sendEmail({
    to:      recipient,
    subject: `FinSurf 3–6M Picks — ${dateStr} | ${regimeLabel}`,
    html,
  })

  return { sent: true, recipient, stockCount: stocks.length, regime: regimeLabel, sentAt: new Date().toISOString() }
}

async function preMarketScan() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }
  const data = await internalPost('/api/ai-brain/scan', { universe: 'broad', maxSignals: 10 }, 90_000)
  const signals = (data.signals ?? []).slice(0, 10).map(s => ({
    symbol: s.symbol, signal: s.signal, confidence: s.confidence, summary: s.summary,
  }))
  return { signals, scannedAt: new Date().toISOString(), universe: 'broad' }
}

async function earningsWatch() {
  const fmpKey = process.env.FMP_API_KEY
  if (!fmpKey) return { skipped: true, reason: 'FMP_API_KEY not set' }
  const today = new Date()
  const from  = today.toISOString().slice(0, 10)
  const to    = new Date(today.getTime() + 5 * 86_400_000).toISOString().slice(0, 10)
  const url   = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${fmpKey}`
  const ctrl  = new AbortController()
  const tid   = setTimeout(() => ctrl.abort(), 15_000)
  let data
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    data = await r.json()
  } finally { clearTimeout(tid) }
  const events = Array.isArray(data) ? data.slice(0, 40).map(e => ({
    symbol: e.symbol, date: e.date, eps: e.eps, epsEstimated: e.epsEstimated, time: e.time,
  })) : []
  return { events, from, to, fetchedAt: new Date().toISOString() }
}

async function macroPulse() {
  if (!process.env.FRED_API_KEY) return { skipped: true, reason: 'FRED_API_KEY not set' }
  const data    = await internalGet('/api/macro/indicators', 30_000)
  const summary = await internalGet('/api/macro/summary', 15_000).catch(() => null)
  return {
    regime:    data.regime ?? null,
    signals:   (data.signals ?? []).slice(0, 5),
    summary:   typeof summary === 'string' ? summary : null,
    refreshedAt: new Date().toISOString(),
  }
}

// ── Hourly AI Broad Scan ──────────────────────────────────────────────────────
// Runs the AI Brain broad scan every hour during market hours and caches the
// result in memory so the UI can read it instantly via GET /api/ai-brain/cached.

const _scanCache = { broad: null, watchlist: null, updatedAt: null }

// Server-side watchlist — updated by POST /api/alerts/watchlist from the client
const _serverWatchlist = new Set(['AAPL', 'NVDA', 'MSFT', 'TSLA', 'SPY', 'BTC-USD', 'ETH-USD'])

function setServerWatchlist(symbols) {
  _serverWatchlist.clear()
  for (const s of symbols) _serverWatchlist.add(s.toUpperCase())
}
function getServerWatchlist() { return [..._serverWatchlist] }

async function hourlyAiScan() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }

  // Run broad scan + watchlist-specific scan in parallel
  const watchlistSymbols = getServerWatchlist()
  const [broadResult, watchlistResult] = await Promise.allSettled([
    internalPost('/api/ai-brain/analyze', { scanMode: 'broad', horizon: '6m' }, 120_000),
    watchlistSymbols.length
      ? Promise.all(watchlistSymbols.map(sym =>
          internalPost('/api/trading-analysis/analyze', {}, 30_000)
            .then(d => ({ symbol: sym, signal: d.signal, confidence: d.confidence, trend: d.trend }))
            .catch(() => ({ symbol: sym, error: 'fetch failed' }))
        ))
      : Promise.resolve([]),
  ])

  _scanCache.updatedAt = new Date().toISOString()

  if (broadResult.status === 'fulfilled') {
    _scanCache.broad = broadResult.value
  }
  if (watchlistResult.status === 'fulfilled') {
    _scanCache.watchlist = watchlistResult.value
  }

  const top = (_scanCache.broad?.rankedStocks ?? []).slice(0, 5).map(s => ({
    symbol: s.symbol, verdict: s.agentVerdict, score: s.compositeScore,
  }))
  return { top, regime: _scanCache.broad?.marketRegime, watchlistAnalyzed: watchlistSymbols.length, updatedAt: _scanCache.updatedAt }
}

function getCachedScan() { return _scanCache }

// ── Watchlist Digest ──────────────────────────────────────────────────────────
// Reads the AI watchlist symbols from the DB (if available) or a static default
// list, runs analyze_symbol on each, and stores per-symbol summaries.

const FALLBACK_WATCHLIST = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'SPY', 'BTC-USD', 'ETH-USD']
const _digestCache = { results: [], updatedAt: null }

async function watchlistDigest() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }

  // Use fallback watchlist — DB-backed watchlist would need auth context
  const symbols = FALLBACK_WATCHLIST

  const results = []
  for (const sym of symbols) {
    try {
      const encoded = encodeURIComponent(sym)
      const r = await fetch(
        `${BASE_URL()}/api/trading-analysis/analyze?symbol=${encoded}&interval=1d`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal': '1' },
          body: JSON.stringify({}), signal: AbortSignal.timeout(30_000) }
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      results.push({
        symbol:     sym,
        signal:     data.signal,
        confidence: data.confidence,
        trend:      data.trend,
        entry:      data.entry,
        stopLoss:   data.stopLoss,
        summary:    (data.reasoning || '').slice(0, 200),
      })
    } catch (e) {
      results.push({ symbol: sym, error: e.message })
    }
  }

  _digestCache.results   = results
  _digestCache.updatedAt = new Date().toISOString()
  return { analyzed: results.length, updatedAt: _digestCache.updatedAt, results }
}

function getCachedDigest() { return _digestCache }

// ── Alt Data Refresh ──────────────────────────────────────────────────────────
// Pre-fetches SEC Form 4 insider + FINRA short interest for top symbols so
// the data is warm when the copilot calls analyze_symbol.

const ALT_DATA_SYMBOLS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'SPY', 'QQQ']
const _altCache = {}

async function altDataRefresh() {
  const results = {}
  await Promise.allSettled(
    ALT_DATA_SYMBOLS.map(async sym => {
      try {
        const snippet = await getAltDataSnippet(sym)
        if (snippet) { results[sym] = snippet; _altCache[sym] = snippet }
      } catch {}
    })
  )
  return { refreshed: Object.keys(results).length, symbols: Object.keys(results), updatedAt: new Date().toISOString() }
}

function getCachedAltData(symbol) { return _altCache[symbol] || null }

// ── Brain Self-Improvement Loop ───────────────────────────────────────────────
// Runs nightly: first resolve 7d/30d outcomes, then run meta-analysis so the
// AI Brain prompt gets updated learnings on the next scan.

async function brainLearningCycle() {
  const outcomes = await resolveOutcomes()
  console.log(`[scheduled-jobs] brain-learning: resolved ${outcomes.resolved7d} @ 7d, ${outcomes.resolved30d} @ 30d`)
  const learnings = await runMetaAnalysis()
  if (learnings) {
    console.log(`[scheduled-jobs] brain-learning: meta-analysis done, win7d=${(learnings.winRate7d * 100).toFixed(0)}%, learnings=${learnings.keyLearnings?.length}`)
    return { outcomes, learnings: { winRate7d: learnings.winRate7d, winRate30d: learnings.winRate30d, count: learnings.keyLearnings?.length } }
  }
  return { outcomes, learnings: null }
}

// ── Registration ───────────────────────────────────────────────────────────────

function init() {
  scheduler.register('morning-brief-email', {
    name:        'Morning Brief Email',
    description: 'Runs AI Brain broad scan and emails top 20 buying signals at 9:30 AM ET, Mon–Fri.',
    schedule:    { type: 'daily', hour: 9, minute: 30, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     morningBriefEmail,
  })

  scheduler.register('pre-market-scan', {
    name:        'Pre-Market AI Scan',
    description: 'AI Brain scans the broad market universe for top trade signals before open.',
    schedule:    { type: 'daily', hour: 8, minute: 30 },
    handler:     preMarketScan,
  })

  scheduler.register('earnings-watch', {
    name:        'Earnings Watch',
    description: 'Fetches upcoming earnings for the next 5 days from FMP.',
    schedule:    { type: 'daily', hour: 7, minute: 0 },
    handler:     earningsWatch,
  })

  scheduler.register('macro-pulse', {
    name:        'Macro Pulse',
    description: 'Refreshes FRED macro indicators and extracts the current market regime.',
    schedule:    { type: 'hourly', minute: 0 },
    handler:     macroPulse,
  })

  scheduler.register('hourly-ai-scan', {
    name:        'Hourly AI Scan',
    description: 'Runs AI Brain broad scan every hour (Mon–Fri) and caches results for instant UI reads.',
    schedule:    { type: 'hourly', minute: 5, weekdaysOnly: true },
    handler:     hourlyAiScan,
  })

  scheduler.register('watchlist-digest', {
    name:        'Watchlist Digest',
    description: 'Analyzes top watchlist symbols each morning at 8 AM ET and caches signals.',
    schedule:    { type: 'daily', hour: 8, minute: 0, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     watchlistDigest,
  })

  scheduler.register('alt-data-refresh', {
    name:        'Alt Data Refresh',
    description: 'Pre-fetches SEC Form 4 insider activity + FINRA short interest for top 10 symbols.',
    schedule:    { type: 'daily', hour: 6, minute: 30 },
    handler:     altDataRefresh,
  })

  scheduler.register('brain-learning-cycle', {
    name:        'AI Brain Self-Improvement',
    description: 'Resolves 7d/30d prediction outcomes then runs Claude meta-analysis to update learnings injected into AI Brain prompts.',
    schedule:    { type: 'daily', hour: 2, minute: 0 },
    handler:     brainLearningCycle,
  })

  // Two registrations cover every :00 and :30 during market hours
  function intradayFocusHandler() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay()
    if (day === 0 || day === 6) return { skipped: true, reason: 'weekend' }
    const mins = et.getHours() * 60 + et.getMinutes()
    const inSession = mins >= 7 * 60 && mins < 16 * 60 + 15 // pre-market + market hours
    if (!inSession) return { skipped: true, reason: 'outside market hours' }
    return runScheduledFocus(getServerWatchlist())
  }

  scheduler.register('intraday-focus-hour', {
    name:        'Intraday Market Focus (:00)',
    description: 'AI focus analysis at every :00 during market hours Mon–Fri.',
    schedule:    { type: 'hourly', minute: 0, weekdaysOnly: true },
    handler:     intradayFocusHandler,
  })

  scheduler.register('intraday-focus-half', {
    name:        'Intraday Market Focus (:30)',
    description: 'AI focus analysis at every :30 during market hours Mon–Fri.',
    schedule:    { type: 'hourly', minute: 30, weekdaysOnly: true },
    handler:     intradayFocusHandler,
  })

  scheduler.start()
  console.log('[scheduled-jobs] 10 jobs registered')
}

module.exports = { init, getCachedScan, getCachedDigest, getCachedAltData, setServerWatchlist, getServerWatchlist }
