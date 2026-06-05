'use strict'

/**
 * lib/scheduled-jobs.js
 *
 * Registers built-in scheduled jobs.
 * Call init() once after the server is listening.
 *
 * Jobs:
 *   morning-brief-email — daily 9:30 AM ET Mon–Fri — AI brain scan + email
 *   pre-market-scan     — daily 8:30 AM server time — AI Brain broad scan
 *   earnings-watch      — daily 7:00 AM server time — upcoming earnings next 5 days
 *   macro-pulse         — hourly :00                — FRED macro refresh
 */

const scheduler  = require('./scheduler')
const { sendEmail } = require('./email')

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
  const signals = (regime.signals ?? []).slice(0, 6)

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

  const rows = stocks.map((s, i) => `
    <tr style="background:${i % 2 === 0 ? '#f8fafc' : '#f1f5f9'};">
      <td style="padding:7px 5px;text-align:center;color:#94a3b8;font-size:11px;">${s.rank}</td>
      <td style="padding:7px 5px;font-weight:700;color:#0f172a;font-size:13px;">${s.symbol}</td>
      <td style="padding:7px 5px;color:#334155;font-size:11px;">${(s.name ?? '').slice(0, 22)}</td>
      <td style="padding:7px 5px;text-align:center;">
        <span style="background:${verdictColor(s.agentVerdict)}18;color:${verdictColor(s.agentVerdict)};padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap;">${s.agentVerdict ?? 'Buy'}</span>
      </td>
      <td style="padding:7px 5px;text-align:center;font-weight:700;color:${scoreColor(s.compositeScore)};font-size:13px;">${Math.round(s.compositeScore ?? 0)}</td>
      <td style="padding:7px 5px;text-align:center;color:#10b981;font-weight:600;font-size:12px;">+${(s.targetReturn ?? 0).toFixed(1)}%</td>
      <td style="padding:7px 5px;text-align:center;color:#ef4444;font-size:12px;">${(s.stopLoss ?? 0).toFixed(1)}%</td>
      <td style="padding:7px 5px;color:#475569;font-size:10px;">${(s.keyDrivers ?? []).join(' · ')}</td>
    </tr>`).join('')

  const signalRows = signals.map(sig => {
    const icon = sig.type === 'warning' ? '⚠️' : sig.type === 'caution' ? '⚡' : '✅'
    return `<tr><td style="padding:5px 0;vertical-align:top;font-size:13px;">${icon}</td><td style="padding:5px 8px;color:#334155;font-size:12px;">${sig.text}</td></tr>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 0;">
<tr><td align="center">
<table width="650" cellpadding="0" cellspacing="0" style="max-width:650px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">

  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:28px 32px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="color:#00ffcc;font-size:22px;font-weight:800;letter-spacing:-.5px;">FinSurf</div>
          <div style="color:#94a3b8;font-size:12px;margin-top:2px;">Morning Brief · AI Buying Signals</div>
        </td>
        <td align="right">
          <div style="color:#e2e8f0;font-size:12px;">${dateStr}</div>
          <div style="margin-top:8px;"><span style="background:${rc}22;color:${rc};border:1px solid ${rc}44;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;">${regimeLabel}</span></div>
        </td>
      </tr>
      ${macroOutlook ? `<tr><td colspan="2" style="padding-top:14px;color:#94a3b8;font-size:12px;border-top:1px solid #2d3f55;padding-top:14px;margin-top:14px;"><span style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Macro Outlook · </span>${macroOutlook}</td></tr>` : ''}
      ${agentTheme  ? `<tr><td colspan="2" style="padding-top:8px;color:#94a3b8;font-size:12px;"><span style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em;">AI Consensus · </span>${agentTheme}</td></tr>` : ''}
    </table>
  </td></tr>

  ${signalRows ? `
  <tr><td style="padding:18px 32px 4px;">
    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Macro Signals</div>
    <table cellpadding="0" cellspacing="0">${signalRows}</table>
  </td></tr>
  <tr><td style="padding:12px 32px 0;"><div style="height:1px;background:#e2e8f0;"></div></td></tr>` : ''}

  <tr><td style="padding:18px 32px 10px;">
    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">AI Buying Signals — Top ${stocks.length} to Watch Today</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Ranked by composite AI score: fundamental · technical · sentiment · macro · risk</div>
  </td></tr>

  <tr><td style="padding:0 16px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
      <thead><tr style="background:#0f172a;">
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">#</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Symbol</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Name</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Signal</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Score</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Target</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Stop</th>
        <th style="padding:7px 5px;color:#64748b;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Key Drivers</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </td></tr>

  <tr><td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:10px;line-height:1.6;">
      Sent automatically by FinSurf AI at 9:30 AM ET, Mon–Fri.
      <strong>Not investment advice.</strong> AI signals are probabilistic. Always do your own research.
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
    internalPost('/api/ai-brain/analyze', { scanMode: 'broad', horizon: '3m' }, 180_000),
  ])

  const macroData = macroResult.status === 'fulfilled' ? macroResult.value : null
  if (brainResult.status === 'rejected')
    throw new Error(`AI Brain analyze failed: ${brainResult.reason?.message ?? brainResult.reason}`)
  const brainData = brainResult.value
  if (!brainData) throw new Error('AI Brain analyze returned empty response')

  const stocks = (brainData.rankedStocks ?? []).slice(0, 20)
  const html   = buildMorningBriefHtml({ stocks, brainData, macroData })

  const regimeLabel = macroData?.regime?.regime ?? brainData?.marketRegime ?? 'N/A'
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  })

  await sendEmail({
    to:      recipient,
    subject: `FinSurf Morning Brief — ${dateStr} | ${regimeLabel}`,
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

  scheduler.start()
  console.log('[scheduled-jobs] 4 jobs registered')
}

module.exports = { init }
