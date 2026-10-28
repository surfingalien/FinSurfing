'use strict'

/**
 * lib/scheduled-jobs.js
 *
 * Registers built-in scheduled jobs.
 * Call init() once after the server is listening.
 *
 * Jobs:
 *   morning-brief-email  — daily 9:30 AM ET Mon–Fri — two fresh AI Brain stock scans → buy / avoid email
 *   strategy-desk-email  — daily 7:00 AM ET Mon–Fri — Advisory for every persona → one email
 *   holdings-research-email — daily 7:45 AM ET Mon–Fri — Research Desk theses on ≤8 holdings (rotating) → email
 *   pre-market-scan      — daily 8:30 AM server time — AI Brain broad scan
 *   earnings-watch       — daily 7:00 AM server time — upcoming earnings next 5 days
 *   macro-pulse          — hourly :00                — FRED macro refresh
 *   hourly-ai-scan       — hourly :05 Mon–Fri        — AI Brain broad scan cached for UI
 *   watchlist-digest     — daily 8:00 AM ET Mon–Fri  — analyze each watchlist symbol
 *   alt-data-refresh     — daily 6:30 AM server time — SEC Form 4 + FINRA short interest cache
 *   brain-evolution      — daily 3:00 AM ET           — re-validate/discover strategies, resolve outcomes
 *   paper-execute        — daily 9:45 AM ET Mon–Fri   — bounded paper trades from cached scan picks
 *   paper-manage         — hourly :20                 — enforce paper brackets (stop / T1 / target / time)
 *   exposure-refresh     — weekly Sun 4:30 AM ET        — rebuild exposure maps, diff relationships
 */

const scheduler  = require('./scheduler')
const { sendEmail } = require('./email')
const { getAltDataSnippet } = require('./alt-data')
const { resolveOutcomes, runMetaAnalysis, readPredictions, checkEntryZones } = require('./brain-learnings')
const { trainFromRecords } = require('./ml-baseline')
const { runEvolutionCycle } = require('./brain-evolution')
const paperBroker = require('./paper-broker')
const learningStore = require('./learning-store')
const { runScheduledFocus } = require('../routes/market-focus')
const symbolDb   = require('./symbol-db')
const { detectFlips } = require('./signal-flips')
const entityGraph = require('./entity-graph')
const broadcaster = require('./alert-broadcaster')
const { INTERNAL_SECRET } = require('./internal-secret')
const morningEmails = require('./morning-emails')
const { esc } = morningEmails
const userHoldings = require('./user-holdings')
const { PERSONAS } = require('./investor-personas')
const { appUrl } = require('./app-url')

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

async function internalGet(path, timeoutMs = 30_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET },
  })
  if (!r.ok) throw new Error(`Internal fetch ${path} → HTTP ${r.status}`)
  return checkBody(path, await r.json())
}

async function internalPost(path, body, timeoutMs = 60_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Internal POST ${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`)
  }
  return checkBody(path, await r.json())
}

// A heartbeated route pins its status to 200 once the first byte is out, so a
// failure arrives as `200 {error}` — and was cached and reported as success.
function checkBody(path, data) {
  if (data && typeof data.error === 'string' && data.error) throw new Error(`${path}: ${data.error}`)
  return data
}

// A broad scan builds its universe, prices every symbol and runs the model —
// often twice (ensemble). Production runs take 3–4 minutes; the old 120s cap
// aborted every pre-market and hourly scan after the model had been paid for.
// Same budget the background queue gives a scan (ai-job-queue JOB_KINDS.scan).
const SCAN_TIMEOUT_MS = 600_000

// Morning emails. The brief runs BRIEF_SCANS fresh 'stocks' scans; the strategy
// desk runs every Advisory persona; holdings research covers up to
// HOLDINGS_PER_DAY holdings, rotating through the rest on later weekdays.
const BRIEF_SCANS = 2
const BRIEF_BUYS = 15
const BRIEF_AVOIDS = 10
const PERSONA_TIMEOUT_MS = 300_000   // a 16k-token Advisory generation
const HOLDINGS_PER_DAY = 8
const THESIS_TIMEOUT_MS = 180_000    // evidence (bars, fundamentals, SEC) + one model call

// ── Email template ────────────────────────────────────────────────────────────

function buildMorningBriefHtml({ stocks, avoids = [], scanned = stocks.length, brainData, macroData }) {
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
    const thesis = esc(s.supervisorSynthesis || (s.keyDrivers ?? []).join(' · ') || '—')
    const bearCase = esc(s.bearCase ?? '—')
    return `
    <tr style="background:${bg};">
      <td style="padding:9px 5px 3px;text-align:center;color:#94a3b8;font-size:11px;vertical-align:top;">${i + 1}</td>
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

  // Weakest first. The model marks "Avoid" only when it believes it, so this
  // list is often shorter than asked for — never padded with low scorers.
  const avoidRows = avoids.map((s, i) => `
    <tr style="background:${i % 2 === 0 ? '#fef2f2' : '#fff7f7'};border-bottom:1px solid #fee2e2;">
      <td style="padding:8px 5px;text-align:center;color:#94a3b8;font-size:11px;vertical-align:top;">${i + 1}</td>
      <td style="padding:8px 5px;vertical-align:top;">
        <div style="font-weight:700;color:#0f172a;font-size:13px;">${esc(s.symbol)}</div>
        <div style="color:#64748b;font-size:10px;margin-top:1px;">${esc(s.sector ?? s.type ?? '')}</div>
      </td>
      <td style="padding:8px 5px;color:#334155;font-size:11px;vertical-align:top;">${esc((s.name ?? '').slice(0, 20))}</td>
      <td style="padding:8px 5px;text-align:center;font-weight:700;color:${scoreColor(s.compositeScore)};font-size:13px;vertical-align:top;">${Math.round(s.compositeScore ?? 0)}</td>
      <td style="padding:8px 5px;color:#7f1d1d;font-size:11px;vertical-align:top;">${esc(s.riskNote || s.bearCase || s.supervisorSynthesis || '—')}</td>
    </tr>`).join('')

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
    <div style="font-size:11px;font-weight:700;color:#0f172a;">Top ${stocks.length} Stocks to Buy — 3 to 6 Month Horizon</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:3px;">AI-ranked from ${scanned} stocks in today's fresh scans · fundamental · technical · sentiment · macro · risk</div>
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

  <tr><td style="padding:4px 32px 10px;">
    <div style="font-size:11px;font-weight:700;color:#7f1d1d;">${avoids.length} Stock${avoids.length === 1 ? '' : 's'} to Avoid</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:3px;">${avoids.length
      ? 'Marked "Avoid" by the AI Brain · weakest first'
      : 'The AI Brain marked nothing "Avoid" today. It only does when it believes it, so the list is not padded.'}</div>
  </td></tr>
  ${avoids.length ? `
  <tr><td style="padding:0 14px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #fecaca;">
      <thead><tr style="background:#7f1d1d;">
        <th style="padding:7px 4px;color:#fecaca;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">#</th>
        <th style="padding:7px 4px;color:#fecaca;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Ticker</th>
        <th style="padding:7px 4px;color:#fecaca;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Name</th>
        <th style="padding:7px 4px;color:#fecaca;font-size:9px;font-weight:600;text-transform:uppercase;text-align:center;">Score</th>
        <th style="padding:7px 4px;color:#fecaca;font-size:9px;font-weight:600;text-transform:uppercase;text-align:left;">Why avoid</th>
      </tr></thead>
      <tbody>${avoidRows}</tbody>
    </table>
  </td></tr>` : ''}

  <tr><td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:10px;line-height:1.6;">
      Sent automatically by FinSurf AI at 9:30 AM ET, Mon–Fri. Two AI Brain scans over fresh stock lists (today's movers plus a rotating draw of large caps), so the names change day to day.
      <strong>Not investment advice.</strong> Past performance does not guarantee future results. Always do your own research.
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function morningBriefEmail() {
  // Skips are logged, not silent: a brief that never arrives looked identical
  // to one that was never attempted.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[scheduled-jobs] morning-brief SKIPPED: ANTHROPIC_API_KEY not set')
    return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }
  }
  const recipient = process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL
  if (!recipient) {
    console.warn('[scheduled-jobs] morning-brief SKIPPED: no recipient (set MORNING_BRIEF_EMAIL or ADMIN_EMAIL)')
    return { skipped: true, reason: 'MORNING_BRIEF_EMAIL or ADMIN_EMAIL not set' }
  }

  // This used to pass the same 20 hard-coded symbols every day, so the brief
  // could only ever re-rank them. Now each scan builds a fresh 'stocks'
  // universe (today's movers + a rotating draw of large caps). The scans run
  // one after the other: the second skips the names the first covered
  // (scan-universe's recent-names rule), which doubles the candidates.
  const macroPromise = internalGet('/api/macro/indicators', 30_000)
    .catch(e => { console.warn('[scheduled-jobs] morning-brief: macro fetch failed (continuing):', e.message); return null })
  const scans = [], failures = []
  for (let i = 0; i < BRIEF_SCANS; i++) {
    try { scans.push(await internalPost('/api/ai-brain/analyze', { scanMode: 'stocks', horizon: '6m' }, SCAN_TIMEOUT_MS)) }
    catch (e) { failures.push(e.message) }
  }
  const macroData = await macroPromise
  if (!scans.length) throw new Error(`AI Brain analyze failed: ${failures.join('; ')}`)
  if (failures.length) console.warn(`[scheduled-jobs] morning-brief: ${failures.length} of ${BRIEF_SCANS} scans failed (continuing):`, failures.join('; '))
  const brainData = scans[0]

  const { buys: stocks, avoids, scanned } = morningEmails.splitBuysAvoids(scans, { buys: BRIEF_BUYS, avoids: BRIEF_AVOIDS })
  // An empty pick list produces a brief with an empty table — that's a failed
  // run, not a successful send, and it should be visible as such.
  if (!stocks.length && !avoids.length)
    throw new Error(`AI Brain returned 0 ranked stocks (llmUsed=${brainData.llmUsed ?? 'unknown'}) — nothing to send`)
  const html   = buildMorningBriefHtml({ stocks, avoids, scanned, brainData, macroData })

  const regimeLabel = macroData?.regime?.regime ?? brainData?.marketRegime ?? 'N/A'
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
  })

  const delivered = await sendEmail({
    to:      recipient,
    subject: `FinSurf 3–6M Picks — ${stocks.length} to buy, ${avoids.length} to avoid — ${dateStr} | ${regimeLabel}`,
    html,
  })

  // delivered=false means no email service configured — content was only console.log'd
  return {
    sent: delivered, emailService: delivered ? 'ok' : 'none-configured', recipient,
    stockCount: stocks.length, avoidCount: avoids.length, scanned, scansFailed: failures.length,
    signals: stocks.map(s => ({ symbol: s.symbol, signal: s.agentVerdict })),
    regime: regimeLabel, sentAt: new Date().toISOString(),
  }
}

const briefRecipient = () => process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL

async function strategyDeskEmail() {
  const recipient = briefRecipient()
  if (!recipient) {
    console.warn('[scheduled-jobs] strategy-desk SKIPPED: no recipient (set MORNING_BRIEF_EMAIL or ADMIN_EMAIL)')
    return { skipped: true, reason: 'MORNING_BRIEF_EMAIL or ADMIN_EMAIL not set' }
  }
  // One Advisory run per persona, in turn: each is a long generation, and ten
  // at once would trip provider rate limits. No userId is passed, on purpose —
  // the route would feed each run the previous persona's picks as "recent
  // history to avoid", and the personas would stop being independent.
  const results = []
  for (const persona of Object.values(PERSONAS)) {
    try {
      const data = await internalPost('/api/recommendations', { persona: persona.id, includeMacro: true }, PERSONA_TIMEOUT_MS)
      results.push({ persona, data })
    } catch (e) {
      results.push({ persona, error: e.message })
    }
  }
  const failed = results.filter(r => r.error)
  if (failed.length === results.length) throw new Error(`every persona run failed: ${failed[0]?.error}`)

  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
  const delivered = await sendEmail({
    to: recipient,
    subject: `FinSurf Strategy Desk — ${results.length} personas — ${dateStr}`,
    html: morningEmails.buildStrategyDeskHtml({ results, dateStr }),
  })
  return {
    sent: delivered, emailService: delivered ? 'ok' : 'none-configured', recipient,
    personas: results.map(r => ({ id: r.persona.id, picks: r.data?.recommendations?.length ?? 0, error: r.error ?? null })),
    sentAt: new Date().toISOString(),
  }
}

async function holdingsResearchEmail() {
  const recipient = briefRecipient()
  if (!recipient) {
    console.warn('[scheduled-jobs] holdings-research SKIPPED: no recipient (set MORNING_BRIEF_EMAIL or ADMIN_EMAIL)')
    return { skipped: true, reason: 'MORNING_BRIEF_EMAIL or ADMIN_EMAIL not set' }
  }
  // The holdings are the recipient's own; fall back to the admin account when
  // the brief goes to an address that is not a sign-in.
  let userId = await userHoldings.userIdForEmail(recipient)
  if (!userId && process.env.ADMIN_EMAIL) userId = await userHoldings.userIdForEmail(process.env.ADMIN_EMAIL)
  if (!userId) return { skipped: true, reason: `no FinSurf account for ${recipient} or ADMIN_EMAIL` }
  const holdings = await userHoldings.holdingSymbols(userId)
  if (!holdings.length) return { skipped: true, reason: 'no holdings in that account\'s portfolios' }

  const today = morningEmails.rotateSlice(holdings, HOLDINGS_PER_DAY, morningEmails.businessDayIndex(new Date()))
  const results = []
  for (const symbol of today) {
    try {
      // userId rides in the body and is honoured only for this verified
      // internal call, so the thesis is saved under the owner's Research Desk.
      const data = await internalPost(`/api/research-desk/${encodeURIComponent(symbol)}/thesis`, { method: 'single', userId }, THESIS_TIMEOUT_MS)
      results.push({ symbol, data })
    } catch (e) {
      results.push({ symbol, error: e.message })
    }
  }
  const failed = results.filter(r => r.error)
  if (failed.length === results.length) throw new Error(`every thesis failed: ${failed[0]?.error}`)

  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
  const actionable = results.filter(r => r.data?.judgement?.verdict === 'actionable').length
  const delivered = await sendEmail({
    to: recipient,
    subject: `FinSurf Holdings Research — ${results.length} holding(s), ${actionable} actionable — ${dateStr}`,
    html: morningEmails.buildHoldingsResearchHtml({ results, holdings, dateStr, appUrl: appUrl() }),
  })
  return {
    sent: delivered, emailService: delivered ? 'ok' : 'none-configured', recipient,
    researched: results.map(r => ({ symbol: r.symbol, verdict: r.data?.judgement?.verdict ?? null, error: r.error ?? null })),
    holdings: holdings.length, sentAt: new Date().toISOString(),
  }
}

async function preMarketScan() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }
  const data = await internalPost('/api/ai-brain/analyze', { scanMode: 'broad', horizon: '6m' }, SCAN_TIMEOUT_MS)

  // Seed the shared scan cache so the UI can read results the moment the market opens,
  // before the first hourlyAiScan fires at :05.
  _scanCache.broad     = data
  _scanCache.updatedAt = new Date().toISOString()

  const signals = (data.rankedStocks ?? []).slice(0, 10).map(s => ({
    symbol:     s.symbol,
    signal:     s.agentVerdict,
    confidence: s.compositeScore,
    summary:    s.supervisorSynthesis || (s.keyDrivers ?? []).join(' · ') || '',
  }))
  return { signals, scannedAt: _scanCache.updatedAt, universe: 'broad', marketRegime: data.marketRegime ?? null }
}

async function earningsWatch() {
  const fmpKey = process.env.FMP_API_KEY
  if (!fmpKey) return { skipped: true, reason: 'FMP_API_KEY not set' }
  const today = new Date()
  const from  = today.toISOString().slice(0, 10)
  const to    = new Date(today.getTime() + 5 * 86_400_000).toISOString().slice(0, 10)
  // lib/fmp never puts the key in an error message, so errors are safe to log.
  const data = await require('./fmp').earningsCalendar(from, to, { key: fmpKey, timeoutMs: 15_000 })
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
// Previous scan's signals/verdicts — baseline for signal-flip alerts
let _prevSignals = { watch: {}, broad: {} }

// Server-side watchlist — updated by POST /api/alerts/watchlist from the client
const _serverWatchlist = new Set(['AAPL', 'NVDA', 'MSFT', 'TSLA', 'SPY', 'BTC-USD', 'ETH-USD'])

function setServerWatchlist(symbols) {
  _serverWatchlist.clear()
  for (const s of symbols) _serverWatchlist.add(s.toUpperCase())
}
function getServerWatchlist() { return [..._serverWatchlist] }

async function hourlyAiScan() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }

  // Only run during US market hours (9:30 AM – 4:30 PM ET, Mon–Fri)
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const mins = et.getHours() * 60 + et.getMinutes()
  if (mins < 9 * 60 + 30 || mins >= 16 * 60 + 30) return { skipped: true, reason: 'outside market hours' }

  // Run broad scan + watchlist-specific scan in parallel
  const watchlistSymbols = getServerWatchlist()
  const [broadResult, watchlistResult] = await Promise.allSettled([
    internalPost('/api/ai-brain/analyze', { scanMode: 'broad', horizon: '6m' }, SCAN_TIMEOUT_MS),
    watchlistSymbols.length
      ? Promise.all(watchlistSymbols.map(sym =>
          internalPost('/api/trading-analysis/analyze', { symbol: sym, interval: 'D' }, 30_000)
            .then(d => ({ symbol: sym, signal: d.analysis?.signal, confidence: d.analysis?.confidence }))
            .catch(() => ({ symbol: sym, error: 'fetch failed' }))
        ))
      : Promise.resolve([]),
  ])

  _scanCache.updatedAt = new Date().toISOString()

  if (broadResult.status === 'fulfilled') {
    _scanCache.broad = broadResult.value
  } else {
    console.warn('[scheduled-jobs] hourly broad scan failed:', broadResult.reason?.message)
  }
  if (watchlistResult.status === 'fulfilled') {
    _scanCache.watchlist = watchlistResult.value
  }

  // Signal-flip alerts: broadcast when a symbol's signal/verdict changed
  // since the previous hourly scan (lib/signal-flips.js). In-memory baseline —
  // no alerts on the first scan after a restart.
  let flipCount = 0
  try {
    const currWatch = Object.fromEntries(
      (_scanCache.watchlist || []).filter(w => w.symbol && w.signal).map(w => [w.symbol, w.signal]))
    const currBroad = Object.fromEntries(
      (_scanCache.broad?.rankedStocks || []).filter(s => s.symbol && s.agentVerdict).map(s => [s.symbol, s.agentVerdict]))
    const flips = [
      ...detectFlips(_prevSignals.watch, currWatch).map(f => ({ ...f, source: 'watchlist-analysis' })),
      ...detectFlips(_prevSignals.broad, currBroad).map(f => ({ ...f, source: 'ai-brain-scan' })),
    ]
    for (const f of flips) {
      broadcaster.broadcast({ type: 'signal-flip', ...f, at: _scanCache.updatedAt })
    }
    flipCount = flips.length
    _prevSignals = { watch: currWatch, broad: currBroad }
    if (flips.length) console.log(`[scheduled-jobs] signal flips: ${flips.map(f => `${f.symbol} ${f.from}→${f.to}`).join(', ')}`)
  } catch (e) { console.warn('[scheduled-jobs] signal-flip detection failed:', e.message) }

  const top = (_scanCache.broad?.rankedStocks ?? []).slice(0, 5).map(s => ({
    symbol: s.symbol, verdict: s.agentVerdict, score: s.compositeScore,
  }))
  // The watchlist half is cached either way, but a run whose broad scan failed
  // is a failed run — it used to read "done" with an empty top list.
  if (broadResult.status === 'rejected')
    throw new Error(`broad scan failed: ${broadResult.reason?.message ?? broadResult.reason}`)
  return { top, regime: _scanCache.broad?.marketRegime, watchlistAnalyzed: watchlistSymbols.length, signalFlips: flipCount, updatedAt: _scanCache.updatedAt }
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
      const r = await fetch(
        `${BASE_URL()}/api/trading-analysis/analyze`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET },
          body: JSON.stringify({ symbol: sym, interval: 'D' }), signal: AbortSignal.timeout(30_000) }
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      results.push({
        symbol:     sym,
        signal:     data.analysis?.signal,
        confidence: data.analysis?.confidence,
        entry:      data.analysis?.entry,
        stopLoss:   data.analysis?.stopLoss,
        summary:    (data.analysis?.summary || '').slice(0, 200),
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

// ── Entry Zone Watch ─────────────────────────────────────────────────────────
// Every 30 min during market hours: check if any recent AI Brain predictions
// have their current price inside the logged entry zone. Fires one SSE alert
// per prediction (idempotent — entryAlertedAt guards repeated triggers).

async function entryZoneWatch() {
  const records = readPredictions()
  const now     = Date.now()
  const MAX_AGE = 90 * 24 * 60 * 60 * 1000

  // Collect symbols that still need a price check (have entry zone, not alerted yet)
  const pending = [...new Set(
    records
      .filter(r =>
        r.entryZoneLow != null && r.entryZoneHigh != null &&
        r.entryAlertedAt == null &&
        now - new Date(r.generatedAt).getTime() <= MAX_AGE
      )
      .map(r => r.symbol)
  )]

  if (!pending.length) return { checked: 0, hits: 0 }

  // Batch-fetch current prices via internal quote API
  const priceMap = {}
  try {
    const batch = pending.slice(0, 40) // cap at 40 to avoid rate-limit pressure
    const data  = await internalGet(`/api/quote?symbols=${encodeURIComponent(batch.join(','))}`, 20_000)
    for (const q of data?.quoteResponse?.result ?? []) {
      const price = q.regularMarketPrice ?? q.price ?? null
      if (q.symbol && price != null) priceMap[q.symbol] = price
    }
  } catch (e) {
    console.warn('[entry-zone-watch] price fetch failed:', e.message)
    return { checked: 0, hits: 0, error: e.message }
  }

  const hits = checkEntryZones(priceMap)
  for (const hit of hits) {
    broadcaster.broadcast({
      type:          'entry_zone',
      symbol:        hit.symbol,
      currentPrice:  hit.currentPrice,
      entryZoneLow:  hit.entryZoneLow,
      entryZoneHigh: hit.entryZoneHigh,
      verdict:       hit.verdict,
      compositeScore: hit.compositeScore,
      targetReturn:  hit.targetReturn,
      generatedAt:   hit.generatedAt,
      firedAt:       new Date().toISOString(),
    })
    console.log(`[entry-zone-watch] ENTRY ZONE HIT: ${hit.symbol} @ $${hit.currentPrice} (zone $${hit.entryZoneLow}–$${hit.entryZoneHigh})`)
  }
  return { checked: pending.length, hits: hits.length }
}

// ── Brain Evolution Cycle ─────────────────────────────────────────────────────
// Nightly: re-validate the strategy library against the LATEST bars (strategies
// that stopped working are retired), discover new configs on a rotating symbol
// slice, and resolve cross-surface decision outcomes. The backtest engine is
// the judge throughout — the LLM only ever proposes.

async function brainEvolution() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY) {
    console.warn('[scheduled-jobs] brain-evolution SKIPPED: no LLM key set (discovery needs one)')
    // Re-validation and outcome resolution need no LLM, so still run those.
    return runEvolutionCycle({ skipDiscovery: true })
  }
  return runEvolutionCycle()
}

// ── Factor Mining ─────────────────────────────────────────────────────────────
// Weekly: which price factors rank a large-cap list by next month's return,
// walk-forward and deflated for the number tried (lib/factor-mining.js).

async function factorMining() {
  const { fetchDailyBars } = require('./internal-api')
  const fm = require('./factor-mining')
  const universe = fm.defaultUniverse()
  // Filing-change fingerprints first (each 10-K/10-Q downloaded once; the
  // backfill is time-budgeted and fills over a few weekly runs).
  const fc = require('./filing-change')
  let filingSims = {}
  try {
    const r = await fc.refresh({ universe })
    filingSims = fc.simsBySymbol(r.store)
    console.log(`[scheduled-jobs] factor-mining: filing change — signed ${r.signed} filings, ${r.pending} still to backfill, ${Object.keys(filingSims).length} names scored`)
  } catch (e) { console.warn('[scheduled-jobs] filing-change refresh failed:', e.message) }
  const lib = await fm.runMining({
    universe, filingSims,
    fetchBars: s => fetchDailyBars(s, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }),
    fetchFacts: s => require('./sec-facts').getCompanyFacts(s),
    // Model-proposed factors join the same gate as extra trials (lib/factor-dsl.js).
    propose: process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY
      ? ({ existing }) => require('./factor-dsl').proposeFactors({ router: require('./ai-router').getRouter('factor-mining'), existing })
      : null,
  })
  console.log(`[scheduled-jobs] factor-mining: ${lib.tested} factors over ${lib.universe}/${lib.requested} names (${lib.withFundamentals} with SEC fundamentals), ${lib.periods} periods — admitted ${lib.admitted.join(', ') || 'none'}; model proposals: ${(lib.proposals || []).map(p => `${p.name || '?'} ${p.status}`).join(', ') || 'none'}`)
  return { tested: lib.tested, admitted: lib.admitted, universe: lib.universe, periods: lib.periods }
}

// ── Post-Earnings Drift Study ─────────────────────────────────────────────────
// Weekly: do large caps that beat estimates keep drifting ahead of SPY over the
// next 20 sessions, net of costs, on older AND newer events (lib/pead.js)?

async function peadStudy() {
  // Without FMP the analyst-surprise track is skipped; the estimate-free SUE
  // track (SEC-reported EPS) still runs.
  const { fetchDailyBars } = require('./internal-api')
  const fmp = require('./fmp')
  const secFacts = require('./sec-facts')
  const hasFmp = !!process.env.FMP_API_KEY
  const tq = Number.isFinite(Number(process.env.PEAD_TONE_QUARTERS)) && process.env.PEAD_TONE_QUARTERS !== '' ? Number(process.env.PEAD_TONE_QUARTERS) : 4
  const s = await require('./pead').runStudy({
    universe:         require('./factor-mining').defaultUniverse(),
    fetchBars:        sym => fetchDailyBars(sym, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }),
    fetchSurprises:   hasFmp ? sym => fmp.earningsSurprises(sym, { limit: 20 }) : null,
    fetchEps:         sym => secFacts.getCompanyFacts(sym).then(secFacts.epsQuarters),
    fetchTranscripts: hasFmp ? (sym, n) => fmp.transcripts(sym, { limit: n, timeoutMs: 15_000 }) : null,
    toneQuarters:     tq,
  })
  console.log(`[scheduled-jobs] pead-study: ${s.universe}/${s.requested} names — analyst track ${s.events} events, long-beats ${s.strategy.verdict}; SUE track ${s.sue.events} events, ${s.sue.strategy.verdict}; tone ${s.tone.verdict}`)
  return { events: s.events, verdict: s.strategy.verdict, sueEvents: s.sue.events, sueVerdict: s.sue.strategy.verdict, tone: s.tone.verdict, universe: s.universe }
}

// ── 13F Holdings Refresh ──────────────────────────────────────────────────────
// Weekly: managers file within 45 days of quarter end, in a trickle.

async function thirteenFRefresh() {
  const s = await require('./thirteenf').refresh()
  console.log(`[scheduled-jobs] 13f-refresh: ${s.managers.length} managers, ${Object.keys(s.bySymbol).length} symbols, ${s.unmapped} unmapped rows; skipped ${s.skipped.map(x => x.manager).join(', ') || 'none'}`)
  return { managers: s.managers.length, symbols: Object.keys(s.bySymbol).length, skipped: s.skipped.length }
}

// ── Insider Buying Study ──────────────────────────────────────────────────────
// Weekly: do opportunistic and cluster insider purchases beat IWM over the next
// 20 sessions after the filing, net of costs, on older AND newer events?

async function insiderStudy() {
  const { fetchDailyBars } = require('./internal-api')
  const s = await require('./insider-buys').runStudy({
    fetchBars: sym => fetchDailyBars(sym, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }),
  })
  console.log(`[scheduled-jobs] insider-study: ${s.quarters} quarters (+${s.added.length}), ${s.purchases} purchases, ${s.universe}/${s.requested} names priced — opportunistic ${s.strategies.opportunistic.verdict}, cluster ${s.strategies.cluster.verdict}`)
  return { quarters: s.quarters, purchases: s.purchases, events: s.events, opportunistic: s.strategies.opportunistic.verdict, cluster: s.strategies.cluster.verdict }
}

// ── Paper Trading Executor ────────────────────────────────────────────────────
// Bounded write access: turns the day's top AI Brain picks into simulated
// positions so advisory calls accrue a real, measurable track record.
// Gated by BOTH the paper-broker kill switch and the AI Brain kill switch —
// either one off means nothing trades.

async function paperExecute() {
  if (!paperBroker.isEnabled())
    return { skipped: true, reason: 'PAPER_TRADING_ENABLED is not "true"' }
  if (process.env.AI_BRAIN_DISABLED === 'true')
    return { skipped: true, reason: 'AI Brain kill switch active' }

  const scan = _scanCache.broad
  const picks = (scan?.rankedStocks ?? []).filter(s => s.symbol && s.currentPrice > 0)
  if (!picks.length) return { skipped: true, reason: 'no cached scan picks to act on' }

  // Only act on genuine conviction — the limits cap size, but they shouldn't
  // be the only thing standing between a weak pick and a position.
  const actionable = picks
    .filter(s => (s.compositeScore ?? 0) >= 70 && /buy/i.test(s.agentVerdict ?? ''))
    // An adopted second-opinion model that says this one will not reach its
    // target first vetoes it (lib/meta-label.js). An unadopted model never does.
    .filter(s => !(s.metaLabel?.validated && s.metaLabel.pass === false))
    .slice(0, 5)

  const executed = [], rejected = []
  for (const pick of actionable) {
    // The card's own trade plan is the bracket: no plan, no position.
    const r = paperBroker.execute({
      symbol: pick.symbol,
      side:   'buy',
      price:  pick.currentPrice,
      reason: `AI Brain ${pick.agentVerdict} score=${pick.compositeScore}`,
      source: 'ai-brain-scan',
      bracket: bracketFromPlan(pick.tradePlan),
      atrPct:  pick.tradePlan?.atrPct ?? null,
    })
    if (r.ok) {
      executed.push({ symbol: pick.symbol, shares: r.trade.shares, value: r.trade.value })
      // Record the ACTION in the shared store so paper trades calibrate too
      learningStore.recordDecision({
        surface: 'paper-broker', symbol: pick.symbol, action: 'buy',
        price: pick.currentPrice, confidence: pick.confidence ?? null,
        meta: { compositeScore: pick.compositeScore ?? null, source: 'ai-brain-scan' },
      })
    } else {
      rejected.push({ symbol: pick.symbol, reason: r.reason })
    }
  }
  console.log(`[scheduled-jobs] paper-execute: ${executed.length} filled, ${rejected.length} rejected`)
  return { executed, rejected, considered: actionable.length, ranAt: new Date().toISOString() }
}

/** A paper bracket from a card's trade plan (lib/trade-levels.js); thesis plans only. */
function bracketFromPlan(plan) {
  if (!plan || plan.basis !== 'thesis') return null
  return { stop: plan.stop?.price, t1: plan.booking?.[0]?.price, t2: plan.booking?.[1]?.price }
}

// ── Paper bracket manager ─────────────────────────────────────────────────────
// Hourly: enforce every open paper position's bracket at the current quote —
// stop, final target, T1 partial (stop to breakeven), time limit. Hourly quotes
// miss what happens between checks in both directions (a T1 spike, a stop
// wick); a gap through a level fills at the worse current price, never the level.

async function paperManage() {
  if (!paperBroker.isEnabled()) return { skipped: true, reason: 'PAPER_TRADING_ENABLED is not "true"' }
  const portfolio = paperBroker.loadPortfolio()
  const symbols = Object.keys(portfolio.positions || {})
  if (!symbols.length) return { skipped: true, reason: 'no open positions' }

  const priceMap = {}
  const data = await internalGet(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`, 20_000)
  for (const q of data?.quoteResponse?.result ?? []) {
    if (q?.symbol && q.regularMarketPrice > 0) priceMap[q.symbol] = q.regularMarketPrice
  }

  const { exits, unmanaged } = paperBroker.bracketExits(portfolio, priceMap)
  const done = []
  for (const x of exits) {
    const r = paperBroker.execute({
      symbol: x.symbol, side: 'sell', price: x.price, fraction: x.fraction, exitKind: x.kind,
      reason: `bracket ${x.kind}`, source: 'paper-bracket', priceMap,
    })
    done.push({ symbol: x.symbol, kind: x.kind, ok: r.ok, realized: r.trade?.realized ?? null, reason: r.ok ? null : r.reason })
  }
  if (done.length) console.log(`[scheduled-jobs] paper-manage: ${done.map(d => `${d.symbol} ${d.kind}${d.ok ? '' : ' (refused)'}`).join(', ')}`)
  return { checked: symbols.length, priced: Object.keys(priceMap).length, exits: done, unmanaged, ranAt: new Date().toISOString() }
}

// ── Exposure map refresh ──────────────────────────────────────────────────────
// Rebuilds every tracked anchor's map and reports what MOVED.
//
// The levels are a reference; the diff is the signal. A supplier that stops
// naming a customer in its concentration disclosure is telling you the
// relationship ended — typically a quarter or more before the revenue line
// does. Weekly is the right cadence: filings land on a quarterly cycle, so
// anything faster re-reads unchanged documents at real cost.

async function exposureRefresh() {
  const tracked = entityGraph.trackedAnchors()
  if (!tracked.length) return { skipped: true, reason: 'no anchors tracked yet' }

  const results = [], allChanges = []
  for (const { anchor } of tracked.slice(0, 10)) {
    try {
      // The route does the diff against the stored snapshot and writes the new
      // one, so this stays a thin trigger rather than a second implementation.
      const d = await internalGet(`/api/exposure/${encodeURIComponent(anchor)}`, 600_000)
      if (d?.error) { results.push({ anchor, error: d.error }); continue }
      results.push({ anchor, edges: d.edges?.length ?? 0, changed: d.diff?.changed ?? 0 })
      if (d.diff?.changed) allChanges.push({ anchor, diff: d.diff })
    } catch (e) {
      results.push({ anchor, error: e.message })
    }
  }

  for (const { anchor, diff } of allChanges) {
    for (const d of diff.dropped ?? []) {
      console.log(`[scheduled-jobs] exposure: ⚠ ${d.symbol} NO LONGER names ${anchor} (was ${d.relation})`)
    }
  }
  console.log(`[scheduled-jobs] exposure-refresh: ${results.length} anchors, ${allChanges.length} with changes`)
  return { results, changedAnchors: allChanges.length, ranAt: new Date().toISOString() }
}

// ── Brain Self-Improvement Loop ───────────────────────────────────────────────
// Runs nightly: first resolve 7d/30d outcomes, then run meta-analysis so the
// AI Brain prompt gets updated learnings on the next scan.

async function brainLearningCycle() {
  const outcomes = await resolveOutcomes()
  console.log(`[scheduled-jobs] brain-learning: resolved ${outcomes.resolved7d} @ 7d, ${outcomes.resolved30d} @ 30d, ${outcomes.resolved90d ?? 0} @ 90d`)
  // Shadow picks resolve on the same rule, from their own file.
  try {
    const bl = require('./brain-learnings')
    const { fetchDailyBars } = require('./internal-api')
    const sh = await require('./shadow-baseline').resolveShadows({
      fetchBars: sym => fetchDailyBars(sym, { range: '1y', headers: { 'x-internal': '1' } }),
      nearestClose: bl.nearestClose, benchmarkFor: bl.benchmarkFor,
    })
    console.log(`[scheduled-jobs] brain-learning: shadow baseline resolved ${sh.resolved}`)
  } catch (e) { console.warn('[scheduled-jobs] shadow baseline resolve failed:', e.message) }
  // Refit the mechanical baseline once enough resolved records carry features
  try {
    const fit = trainFromRecords(readPredictions())
    // A rejected refit is the gate working, not a failure — log it as loudly as
    // a promotion so a model that stops improving is visible in the job output.
    const v = fit.validation
    console.log(`[scheduled-jobs] brain-learning: baseline ${
      !fit.trained ? `waiting for data (${fit.rows}/${fit.needed})`
      : fit.promoted ? `PROMOTED on ${fit.rows} rows (holdout acc ${v.candidate.accuracy} vs incumbent ${v.incumbent.accuracy}, base ${v.baseRate})`
      : `refit REJECTED, keeping incumbent — ${fit.reason}`}`)
  } catch (e) { console.warn('[scheduled-jobs] baseline training failed:', e.message) }
  // Second-opinion model (meta-labelling) — refit nightly, adopted only if it
  // beats the base rate on the newest picks it never saw.
  try {
    const metaLabel = require('./meta-label')
    const m = metaLabel.trainFromRecords(readPredictions())
    metaLabel.saveModel(m)
    console.log(`[scheduled-jobs] brain-learning: meta-label ${m.validated ? 'ADOPTED' : 'not adopted'} — ${m.reason}`)
  } catch (e) { console.warn('[scheduled-jobs] meta-label training failed:', e.message) }
  // The bracket win probability Kelly + the EV gate size on — adopted only if it
  // predicts the target/stop outcome of newer picks better than the current rate.
  try {
    const bracket = require('./bracket-prob')
    const b = bracket.trainFromRecords(readPredictions())
    bracket.saveStore(b)
    console.log(`[scheduled-jobs] brain-learning: bracket probability ${b.adopted ? `ADOPTED (${b.adopted})` : 'not adopted'} — ${b.reason}`)
  } catch (e) { console.warn('[scheduled-jobs] bracket probability training failed:', e.message) }
  const learnings = await runMetaAnalysis()
  if (learnings) {
    console.log(`[scheduled-jobs] brain-learning: meta-analysis done, win7d=${(learnings.winRate7d * 100).toFixed(0)}%, learnings=${learnings.keyLearnings?.length}`)
    return { outcomes, learnings: { winRate7d: learnings.winRate7d, winRate30d: learnings.winRate30d, count: learnings.keyLearnings?.length } }
  }
  return { outcomes, learnings: null }
}

// ── Registration ───────────────────────────────────────────────────────────────

function init() {
  // Warn at startup if morning brief cannot run
  if (!process.env.ANTHROPIC_API_KEY)
    console.warn('[scheduled-jobs] WARNING: ANTHROPIC_API_KEY not set — morning-brief-email will be skipped')
  if (!process.env.MORNING_BRIEF_EMAIL && !process.env.ADMIN_EMAIL)
    console.warn('[scheduled-jobs] WARNING: MORNING_BRIEF_EMAIL and ADMIN_EMAIL not set — morning-brief-email will be skipped (no recipient)')
  if (!process.env.RESEND_API_KEY && !process.env.SMTP_HOST)
    console.warn('[scheduled-jobs] WARNING: No email service configured (set RESEND_API_KEY or SMTP_HOST) — morning-brief-email will fall back to console.log only')

  scheduler.register('morning-brief-email', {
    name:        'Morning Brief Email',
    description: 'Two fresh AI Brain stock scans; emails up to 15 to buy and up to 10 to avoid at 9:30 AM ET, Mon–Fri.',
    schedule:    { type: 'daily', hour: 9, minute: 30, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     morningBriefEmail,
  })

  scheduler.register('strategy-desk-email', {
    name:        'Strategy Desk Email',
    description: 'Runs Advisory for all 10 investor personas and emails each one\'s picks at 7:00 AM ET, Mon–Fri.',
    schedule:    { type: 'daily', hour: 7, minute: 0, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     strategyDeskEmail,
  })

  scheduler.register('holdings-research-email', {
    name:        'Holdings Research Email',
    description: 'Research Desk thesis on up to 8 of your holdings (rotating) and emails the verdicts at 7:45 AM ET, Mon–Fri.',
    schedule:    { type: 'daily', hour: 7, minute: 45, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     holdingsResearchEmail,
  })

  scheduler.register('pre-market-scan', {
    name:        'Pre-Market AI Scan',
    description: 'AI Brain scans the broad market universe for top trade signals before open.',
    // ET + weekdays: "pre-market" is meaningless in server-local UTC (fired
    // ~4:30 AM ET, and on weekends) — anchor it to 8:30 AM ET before the open.
    schedule:    { type: 'daily', hour: 8, minute: 30, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     preMarketScan,
  })

  scheduler.register('earnings-watch', {
    name:        'Earnings Watch',
    description: 'Fetches upcoming earnings for the next 5 days from FMP.',
    // ET + weekdays for the same reason (was firing ~3 AM ET, incl. weekends).
    schedule:    { type: 'daily', hour: 7, minute: 0, timezone: 'America/New_York', weekdaysOnly: true },
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

  // Runs AFTER the learning cycle so the night's resolved outcomes are already
  // in the store when strategies are re-validated and outcomes recalculated.
  scheduler.register('brain-evolution', {
    name:        'AI Brain Evolution',
    description: 'Re-validates the strategy library on fresh bars (retiring decayed strategies), discovers new backtest-validated strategies, and resolves cross-surface decision outcomes.',
    schedule:    { type: 'daily', hour: 3, minute: 0, timezone: 'America/New_York' },
    handler:     brainEvolution,
  })

  // Just after the open, acting on the pre-market/hourly scan already cached.
  scheduler.register('exposure-refresh', {
    name:        'Exposure Map Refresh',
    description: 'Rebuilds tracked supply-chain/peer maps from SEC filings and reports relationships added, dropped, or materially resized.',
    // Weekly: filings arrive on a quarterly cycle, so a faster cadence re-reads
    // unchanged documents for nothing. Sunday, off the weekday job contention.
    schedule:    { type: 'weekly', dayOfWeek: 0, hour: 4, minute: 30, timezone: 'America/New_York' },
    handler:     exposureRefresh,
  })

  scheduler.register('factor-mining', {
    name:        'Factor Mining',
    description: 'Tests which price-based factors rank ~70 large caps by their next-month return (walk-forward, corrected for how many were tried) and keeps the survivors for the Research Desk.',
    // Weekly — a monthly-horizon test gains nothing from a daily re-run. Saturday, off the weekday job contention.
    schedule:    { type: 'weekly', dayOfWeek: 6, hour: 5, minute: 15, timezone: 'America/New_York' },
    handler:     factorMining,
  })

  scheduler.register('pead-study', {
    name:        'Post-Earnings Drift Study',
    description: 'Tests whether large caps that beat EPS estimates — analyst consensus (FMP) and an estimate-free SUE from SEC-reported EPS — keep beating SPY over the next 20 sessions (net of costs, older vs newer events), and whether improving call tone adds to it.',
    // Weekly: earnings arrive quarterly. Sunday after the exposure refresh.
    schedule:    { type: 'weekly', dayOfWeek: 0, hour: 5, minute: 30, timezone: 'America/New_York' },
    handler:     peadStudy,
  })

  scheduler.register('13f-refresh', {
    name:        '13F Holdings Refresh',
    description: 'Reads the two latest SEC 13F filings of ~23 discretionary fund managers and records what each opened, added, trimmed or sold.',
    schedule:    { type: 'weekly', dayOfWeek: 0, hour: 6, minute: 15, timezone: 'America/New_York' },
    handler:     thirteenFRefresh,
  })

  scheduler.register('insider-study', {
    name:        'Insider Buying Study',
    description: 'Reads SEC Form 4 data sets, separates opportunistic from routine and plan purchases, and measures whether opportunistic and cluster buys beat IWM after the filing.',
    schedule:    { type: 'weekly', dayOfWeek: 0, hour: 6, minute: 45, timezone: 'America/New_York' },
    handler:     insiderStudy,
  })

  scheduler.register('paper-execute', {
    name:        'Paper Trading Executor',
    description: 'Executes high-conviction AI Brain picks into the bounded paper portfolio (off unless PAPER_TRADING_ENABLED=true).',
    schedule:    { type: 'daily', hour: 9, minute: 45, timezone: 'America/New_York', weekdaysOnly: true },
    handler:     paperExecute,
  })

  scheduler.register('paper-manage', {
    name:        'Paper Bracket Manager',
    description: 'Enforces each paper position\'s stop / T1 (half, stop to breakeven) / target / time exit at the current quote, hourly (off unless PAPER_TRADING_ENABLED=true).',
    schedule:    { type: 'hourly', minute: 20 },
    handler:     paperManage,
  })

  // Two registrations cover every :00 and :30 during market hours
  function intradayFocusHandler() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay()
    if (day === 0 || day === 6) return { skipped: true, reason: 'weekend' }
    const mins = et.getHours() * 60 + et.getMinutes()
    const inSession = mins >= 7 * 60 && mins < 16 * 60 + 15 // pre-market + market hours
    if (!inSession) return { skipped: true, reason: 'outside market hours' }
    return runScheduledFocus([], getServerWatchlist())
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

  scheduler.register('symbol-db-refresh', {
    name:        'Symbol DB Refresh',
    description: 'Re-downloads the FinanceDatabase symbol snapshot (updated upstream on Sundays).',
    schedule:    { type: 'weekly', dayOfWeek: 1, hour: 5, minute: 30, timezone: 'America/New_York' },
    handler:     () => symbolDb.refresh(),
  })

  // Two registrations cover :05 and :35 so we check within 30 min of any price move
  function entryZoneWatchHandler() {
    const et  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay()
    if (day === 0 || day === 6) return { skipped: true, reason: 'weekend' }
    const mins = et.getHours() * 60 + et.getMinutes()
    if (mins < 9 * 60 + 30 || mins >= 16 * 60) return { skipped: true, reason: 'outside market hours' }
    return entryZoneWatch()
  }

  scheduler.register('entry-zone-watch-hour', {
    name:        'Entry Zone Watch (:05)',
    description: 'Checks if any AI Brain prediction entry zones have been entered by live price.',
    schedule:    { type: 'hourly', minute: 5, weekdaysOnly: true },
    handler:     entryZoneWatchHandler,
  })

  scheduler.register('entry-zone-watch-half', {
    name:        'Entry Zone Watch (:35)',
    description: 'Checks if any AI Brain prediction entry zones have been entered by live price.',
    schedule:    { type: 'hourly', minute: 35, weekdaysOnly: true },
    handler:     entryZoneWatchHandler,
  })

  scheduler.start()
  console.log(`[scheduled-jobs] ${scheduler.getStatus().length} jobs registered`)

  // Populate the symbol DB shortly after boot when no snapshot is on disk yet
  // (Railway disks are ephemeral across deploys). Deferred so startup stays fast.
  if (!symbolDb.stats().loaded) {
    setTimeout(() => {
      symbolDb.refresh().catch(e => console.warn('[scheduled-jobs] symbol-db initial load failed:', e.message))
    }, 30_000)
  }
}

module.exports = {
  init, getCachedScan, getCachedDigest, getCachedAltData, setServerWatchlist, getServerWatchlist,
  SCAN_TIMEOUT_MS, _preMarketScanForTests: () => preMarketScan(), _hourlyAiScanForTests: () => hourlyAiScan(),
  bracketFromPlan, _paperManageForTests: () => paperManage(),
  _morningBriefEmailForTests: () => morningBriefEmail(),
  _strategyDeskEmailForTests: () => strategyDeskEmail(),
  _holdingsResearchEmailForTests: () => holdingsResearchEmail(),
}
