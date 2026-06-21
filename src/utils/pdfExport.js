/**
 * pdfExport.js — Generate print-friendly HTML reports for AI Brain & Buy Signals.
 *
 * Usage:
 *   import { exportAnalysisToPDF } from '../utils/pdfExport'
 *   exportAnalysisToPDF(analysis, '6m')
 */

/* ── helpers ─────────────────────────────────────────────── */

function escHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtPrice(val) {
  if (val == null || isNaN(val)) return '—'
  const n = Number(val)
  if (n === 0) return '—'
  return `$${n.toFixed(2)}`
}

function fmtPct(val, sign = true) {
  if (val == null || isNaN(val)) return '—'
  const n = Number(val)
  if (n === 0) return '0%'
  return sign && n > 0 ? `+${n}%` : `${n}%`
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function horizonLabel(h) {
  const map = { '3m': '3-Month', '6m': '6-Month', '12m': '12-Month' }
  return map[h] || h || '—'
}

function scoreColor(score) {
  if (score == null) return '#6b7280'
  if (score >= 75) return '#10b981'
  if (score >= 55) return '#f59e0b'
  return '#ef4444'
}

function verdictColor(verdict) {
  if (!verdict) return '#6b7280'
  const v = verdict.toLowerCase()
  if (v.includes('strong buy')) return '#10b981'
  if (v.includes('buy'))        return '#34d399'
  if (v.includes('moderate'))   return '#f59e0b'
  return '#6b7280'
}

/* ── Format entry / target / stop zones ─────────────────── */
function fmtZone(low, high) {
  if (low != null && high != null && (low > 0 || high > 0))
    return `$${Number(low).toFixed(2)}&nbsp;–&nbsp;$${Number(high).toFixed(2)}`
  return '—'
}

function fmtStopLoss(stock) {
  // Prefer AI Brain stop zone (absolute dollar levels)
  if (stock.stopZoneLow != null || stock.stopZoneHigh != null)
    return fmtZone(stock.stopZoneLow, stock.stopZoneHigh)
  // Fallback: calculate from percentage + current price
  const pct   = stock.stopLoss
  const price = stock.currentPrice
  if (pct != null && pct > 0 && price != null && price > 0) {
    const slPrice = price * (1 - pct / 100)
    return `$${slPrice.toFixed(2)}<br/><span style="font-size:10px;color:#ef4444;">–${pct}%</span>`
  }
  if (stock.stopLossPrice != null) return fmtPrice(stock.stopLossPrice)
  return '—'
}

/* ── Agent market views (global, not per-stock) ─────────── */
function buildAgentNotesRows(agentNotes) {
  if (!agentNotes) return ''
  const agents = [
    { key: 'fundamentalAnalyst', label: 'Fundamental', color: '#60a5fa' },
    { key: 'technicalAnalyst',   label: 'Technical',   color: '#22d3ee' },
    { key: 'sentimentAnalyst',   label: 'Sentiment',   color: '#a78bfa' },
    { key: 'macroEconomist',     label: 'Macro',       color: '#fbbf24' },
    { key: 'riskManager',        label: 'Risk',        color: '#f87171' },
  ]
  return agents.map(a => {
    const note = agentNotes[a.key]
    if (!note) return ''
    return `
      <div class="agent-note" style="border-left:3px solid ${a.color};">
        <div class="agent-label" style="color:${a.color};">${escHtml(a.label)} Agent</div>
        <div class="agent-text">${escHtml(note)}</div>
      </div>`
  }).join('')
}

/* ── Summary table rows ──────────────────────────────────── */
function buildStockRows(rankedStocks, horizon) {
  if (!Array.isArray(rankedStocks) || !rankedStocks.length)
    return '<tr><td colspan="12" style="text-align:center;color:#9ca3af;padding:20px;">No ranked stocks available.</td></tr>'

  return rankedStocks.map(s => {
    const scoreClr   = scoreColor(s.compositeScore)
    const verdictClr = verdictColor(s.agentVerdict)

    // Entry zone (AI Brain returns entryZoneLow/High; fallback to entryPrice)
    const entryStr = (s.entryZoneLow != null || s.entryZoneHigh != null)
      ? fmtZone(s.entryZoneLow, s.entryZoneHigh)
      : fmtPrice(s.entryPrice)

    // Target zone
    const targetStr = (s.targetZoneLow != null || s.targetZoneHigh != null)
      ? fmtZone(s.targetZoneLow, s.targetZoneHigh)
      : fmtPrice(s.takeProfitPrice)

    // Stop loss: calculate price from pct, fallback to stored price
    const stopStr = fmtStopLoss(s)

    // Horizon: per-stock if set, otherwise the analysis-level horizon
    const stockHorizon = s.horizon || horizon || '—'

    return `
      <tr>
        <td style="text-align:center;font-weight:700;">${escHtml(s.rank)}</td>
        <td style="font-family:monospace;font-weight:700;">${escHtml(s.symbol)}</td>
        <td>${escHtml(s.name)}</td>
        <td>${escHtml(s.sector)}</td>
        <td style="text-align:center;font-weight:700;color:${scoreClr};">${s.compositeScore ?? '—'}</td>
        <td style="color:${verdictClr};font-weight:600;">${escHtml(s.agentVerdict)}</td>
        <td style="text-align:right;font-family:monospace;">${fmtPrice(s.currentPrice)}</td>
        <td style="text-align:right;font-family:monospace;font-size:11px;" class="zone-cell">${entryStr}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;font-size:11px;" class="zone-cell">${targetStr}</td>
        <td style="text-align:right;font-family:monospace;" class="zone-cell">${stopStr}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;font-weight:600;">${fmtPct(s.targetReturn)}</td>
        <td style="text-align:center;">${escHtml(horizonLabel(stockHorizon))}</td>
      </tr>`
  }).join('')
}

/* ── Per-stock Fundamental / Technical / Sentiment / Macro / Risk ── */
function buildStockDetailSections(rankedStocks) {
  if (!Array.isArray(rankedStocks) || !rankedStocks.length) return ''

  const agentDefs = [
    { scoreKey: 'fundamentalScore', textKey: 'fundamentalAnalysis', label: 'Fundamental', color: '#60a5fa' },
    { scoreKey: 'technicalScore',   textKey: 'technicalAnalysis',   label: 'Technical',   color: '#22d3ee' },
    { scoreKey: 'sentimentScore',   textKey: 'sentimentAnalysis',   label: 'Sentiment',   color: '#a78bfa' },
    { scoreKey: 'macroScore',       textKey: 'macroAnalysis',       label: 'Macro',       color: '#fbbf24' },
    { scoreKey: 'riskScore',        textKey: 'riskNote',            label: 'Risk',        color: '#f87171' },
  ]

  return rankedStocks.map(s => {
    const scoreClr   = scoreColor(s.compositeScore)
    const verdictClr = verdictColor(s.agentVerdict)

    const agentCards = agentDefs.map(a => {
      const score = s[a.scoreKey]
      const text  = s[a.textKey]
      if (!text && score == null) return ''
      const sClr = scoreColor(score)
      return `
        <div class="detail-agent-card" style="border-left:3px solid ${a.color};">
          <div class="detail-agent-header">
            <span class="detail-agent-label" style="color:${a.color};">${a.label}</span>
            ${score != null ? `<span class="detail-agent-score" style="color:${sClr};">${score}</span>` : ''}
          </div>
          <div class="detail-agent-text">${escHtml(text || '—')}</div>
        </div>`
    }).join('')

    const entryStr = (s.entryZoneLow != null || s.entryZoneHigh != null)
      ? fmtZone(s.entryZoneLow, s.entryZoneHigh)
      : fmtPrice(s.entryPrice)
    const targetStr = (s.targetZoneLow != null || s.targetZoneHigh != null)
      ? fmtZone(s.targetZoneLow, s.targetZoneHigh)
      : fmtPrice(s.takeProfitPrice)
    const stopStr = fmtStopLoss(s)

    return `
      <div class="stock-detail">
        <div class="stock-detail-header">
          <span class="stock-detail-rank">#${escHtml(s.rank)}</span>
          <span class="stock-detail-symbol">${escHtml(s.symbol)}</span>
          <span class="stock-detail-name">${escHtml(s.name)}</span>
          <span class="stock-detail-sector">${escHtml(s.sector)}</span>
          <span class="stock-detail-score" style="color:${scoreClr};">${s.compositeScore ?? '—'}</span>
          <span class="stock-detail-verdict" style="color:${verdictClr};">${escHtml(s.agentVerdict)}</span>
        </div>
        <div class="stock-detail-prices">
          <div class="price-pill">
            <span class="price-pill-label">Current</span>
            <span class="price-pill-value">${fmtPrice(s.currentPrice)}</span>
          </div>
          <div class="price-pill">
            <span class="price-pill-label">Entry Zone</span>
            <span class="price-pill-value">${entryStr}</span>
          </div>
          <div class="price-pill">
            <span class="price-pill-label">Target Zone</span>
            <span class="price-pill-value" style="color:#10b981;">${targetStr}</span>
          </div>
          <div class="price-pill">
            <span class="price-pill-label">Stop Loss</span>
            <span class="price-pill-value" style="color:#ef4444;">${stopStr}</span>
          </div>
          <div class="price-pill">
            <span class="price-pill-label">Return</span>
            <span class="price-pill-value" style="color:#10b981;font-weight:700;">${fmtPct(s.targetReturn)}</span>
          </div>
        </div>
        ${s.highConviction ? `<div style="margin:8px 0;padding:6px 12px;border-radius:6px;background:#fef3c7;border:1px solid #fbbf24;font-size:11px;font-weight:700;color:#92400e;">⭐ HIGH CONVICTION — Multiple confirming signals align</div>` : ''}
        ${s.catalyst ? `<div style="margin:8px 0;padding:6px 12px;border-radius:6px;background:#f5f3ff;border:1px solid #8b5cf6;font-size:11px;color:#5b21b6;"><strong>⚡ Catalyst:</strong> ${escHtml(s.catalyst)}</div>` : ''}
        <div class="detail-agents-grid">
          ${agentCards}
        </div>
      </div>`
  }).join('')
}

/* ── Full HTML document ──────────────────────────────────── */
function buildHTML(analysis, horizon) {
  const {
    rankedStocks        = [],
    marketRegime        = '—',
    macroOutlook        = '—',
    agentConsensusTheme = '—',
    agentNotes,
    processedAt,
    universeAnalyzed    = [],
  } = analysis

  const agentNoteRows     = buildAgentNotesRows(agentNotes)
  const stockRows         = buildStockRows(rankedStocks, horizon)
  const stockDetailBlocks = buildStockDetailSections(rankedStocks)
  const universeStr       = Array.isArray(universeAnalyzed) ? universeAnalyzed.join(', ') : '—'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Brain Analysis Report — FinSurfing</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 14px; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #fff;
      color: #111827;
      line-height: 1.5;
      padding: 32px 40px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .print-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 24px;
      padding: 8px 16px;
      background: #1d4ed8;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .print-btn:hover { background: #1e40af; }

    .report-header {
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .report-title { font-size: 26px; font-weight: 800; color: #111827; letter-spacing: -0.5px; }
    .report-subtitle { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 16px; }
    .meta-item { display: flex; flex-direction: column; gap: 2px; }
    .meta-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; }
    .meta-value { font-size: 13px; font-weight: 600; color: #111827; }

    .section { margin-bottom: 32px; }
    .section-title {
      font-size: 13px; font-weight: 800; text-transform: uppercase;
      letter-spacing: 0.08em; color: #374151;
      padding-bottom: 8px; border-bottom: 1px solid #f3f4f6; margin-bottom: 16px;
    }

    .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .overview-card {
      background: #f9fafb; border: 1px solid #e5e7eb;
      border-radius: 10px; padding: 16px;
    }
    .overview-card-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 6px; }
    .overview-card-main  { font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 4px; }
    .overview-card-body  { font-size: 12px; color: #4b5563; line-height: 1.6; }
    .universe-text { font-size: 11px; color: #9ca3af; margin-top: 8px; font-family: monospace; }

    .agent-notes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .agent-note { background: #f9fafb; border-radius: 8px; padding: 12px 12px 12px 14px; }
    .agent-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
    .agent-text  { font-size: 11px; color: #4b5563; line-height: 1.55; }

    /* ── Summary table ── */
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead tr { background: #f3f4f6; }
    th {
      text-align: left; padding: 8px 10px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; color: #6b7280; border-bottom: 1px solid #e5e7eb;
    }
    td { padding: 9px 10px; border-bottom: 1px solid #f3f4f6; color: #111827; vertical-align: middle; }
    tbody tr:hover { background: #f9fafb; }
    tbody tr:last-child td { border-bottom: none; }
    .zone-cell { font-size: 11px; line-height: 1.4; }

    /* ── Per-stock detail sections ── */
    .stock-detail {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
      background: #fafafa;
      page-break-inside: avoid;
    }
    .stock-detail-header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid #e5e7eb;
    }
    .stock-detail-rank   { font-size: 11px; color: #9ca3af; font-weight: 700; }
    .stock-detail-symbol { font-size: 16px; font-weight: 800; font-family: monospace; color: #111827; }
    .stock-detail-name   { font-size: 13px; color: #374151; }
    .stock-detail-sector { font-size: 11px; color: #6b7280; background: #f3f4f6; border-radius: 4px; padding: 2px 6px; }
    .stock-detail-score  { font-size: 15px; font-weight: 800; margin-left: auto; }
    .stock-detail-verdict { font-size: 12px; font-weight: 600; }

    .stock-detail-prices {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 14px;
    }
    .price-pill {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      padding: 6px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 90px;
    }
    .price-pill-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #9ca3af; }
    .price-pill-value { font-size: 12px; font-weight: 600; font-family: monospace; color: #111827; }

    .detail-agents-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 10px;
    }
    .detail-agent-card {
      background: #fff;
      border-radius: 6px;
      padding: 10px 10px 10px 12px;
      border: 1px solid #f3f4f6;
    }
    .detail-agent-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 5px;
    }
    .detail-agent-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; }
    .detail-agent-score { font-size: 13px; font-weight: 800; }
    .detail-agent-text  { font-size: 11px; color: #4b5563; line-height: 1.5; }

    /* ── Disclaimer ── */
    .disclaimer {
      background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
      padding: 14px 16px; font-size: 11px; color: #9ca3af; line-height: 1.6; margin-top: 32px;
    }
    .disclaimer strong { color: #6b7280; }

    /* ── Print ── */
    @media print {
      body { padding: 14px 18px; }
      .print-btn { display: none !important; }
      table { font-size: 10px; }
      th, td { padding: 5px 7px; }
      .overview-grid { grid-template-columns: 1fr 1fr; }
      .agent-notes-grid { grid-template-columns: repeat(3, 1fr); }
      .section { margin-bottom: 18px; }
      .overview-card, .agent-note, .disclaimer, .stock-detail { border: 1px solid #d1d5db; }
      .detail-agents-grid { grid-template-columns: repeat(5, 1fr); }
      a { text-decoration: none; color: inherit; }
      @page { margin: 10mm 12mm; size: A4 landscape; }
    }
  </style>
</head>
<body>

  <button class="print-btn" onclick="window.print()">&#x1F5A8;&#xFE0F; Print / Save as PDF</button>

  <div class="report-header">
    <div class="report-title">AI Brain Analysis Report</div>
    <div class="report-subtitle">FinSurfing · Multi-Agent AI Stock Analysis</div>
    <div class="report-meta">
      <div class="meta-item">
        <span class="meta-label">Generated</span>
        <span class="meta-value">${escHtml(fmtDate(processedAt))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Horizon</span>
        <span class="meta-value">${escHtml(horizonLabel(horizon))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Picks</span>
        <span class="meta-value">${rankedStocks.length}</span>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Market Overview</div>
    <div class="overview-grid">
      <div class="overview-card">
        <div class="overview-card-title">Market Regime</div>
        <div class="overview-card-main">${escHtml(marketRegime)}</div>
        <div class="overview-card-body">${escHtml(macroOutlook)}</div>
      </div>
      <div class="overview-card">
        <div class="overview-card-title">Agent Consensus</div>
        <div class="overview-card-body">${escHtml(agentConsensusTheme)}</div>
        ${universeStr ? `<div class="universe-text">Universe: ${escHtml(universeStr)}</div>` : ''}
      </div>
    </div>
  </div>

  ${agentNoteRows ? `
  <div class="section">
    <div class="section-title">Agent Market Views</div>
    <div class="agent-notes-grid">${agentNoteRows}</div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">Ranked Stock Picks — ${escHtml(horizonLabel(horizon))} Horizon</div>
    <table>
      <thead>
        <tr>
          <th style="width:34px;">Rank</th>
          <th style="width:58px;">Symbol</th>
          <th>Name</th>
          <th>Sector</th>
          <th style="width:44px;text-align:center;">Score</th>
          <th style="width:90px;">Verdict</th>
          <th style="width:76px;text-align:right;">Curr. Price</th>
          <th style="width:110px;text-align:right;">Entry Zone</th>
          <th style="width:110px;text-align:right;">Target Zone</th>
          <th style="width:90px;text-align:right;">Stop Loss</th>
          <th style="width:68px;text-align:right;">Return %</th>
          <th style="width:58px;text-align:center;">Horizon</th>
        </tr>
      </thead>
      <tbody>${stockRows}</tbody>
    </table>
  </div>

  ${stockDetailBlocks ? `
  <div class="section">
    <div class="section-title">Detailed Analysis — Fundamental · Technical · Sentiment · Macro · Risk</div>
    ${stockDetailBlocks}
  </div>` : ''}

  <div class="disclaimer">
    <strong>Disclaimer:</strong> This report is generated by AI agents for <strong>informational purposes only</strong>
    and does <strong>not</strong> constitute financial, investment, or trading advice. AI-generated scores, verdicts,
    and price targets are estimates based on model training data and available market information — they do
    <strong>not</strong> guarantee future results. Past performance is not indicative of future returns.
    Always conduct your own independent research and consult a qualified financial adviser before making
    any investment decisions. FinSurfing and its AI systems accept no liability for investment outcomes.
  </div>

</body>
</html>`
}

/* ── Main export ─────────────────────────────────────────── */

export function exportAnalysisToPDF(analysis, horizon) {
  if (!analysis) {
    console.warn('exportAnalysisToPDF: no analysis provided')
    return null
  }

  const html = buildHTML(analysis, horizon)

  const newWindow = window.open('', '_blank')
  if (!newWindow) {
    alert(
      'Pop-up blocked. Please allow pop-ups for this site and try again.\n\n' +
      'Or use your browser\'s "Print" shortcut (Ctrl+P / Cmd+P) directly.'
    )
    return null
  }

  newWindow.document.open()
  newWindow.document.write(html)
  newWindow.document.close()

  setTimeout(() => {
    try { newWindow.print() } catch (e) {
      console.warn('exportAnalysisToPDF: auto-print failed', e)
    }
  }, 500)

  return newWindow
}

/* ── Buy Signals HTML ────────────────────────────────────── */
function buildBuySignalsHTML(recs) {
  const {
    recommendations = [],
    marketOutlook   = '—',
    keyRisks        = '',
    generatedAt,
  } = recs

  const rows = recommendations.length === 0
    ? '<tr><td colspan="11" style="text-align:center;color:#9ca3af;padding:20px;">No recommendations available.</td></tr>'
    : recommendations.map(r => `
      <tr>
        <td style="font-family:monospace;font-weight:700;">${escHtml(r.symbol)}</td>
        <td>${escHtml(r.name)}</td>
        <td>${escHtml(r.type)}</td>
        <td style="text-align:center;">${escHtml(r.period)}</td>
        <td>${escHtml(r.sector)}</td>
        <td style="text-align:center;">${escHtml(r.risk)}</td>
        <td style="text-align:right;font-family:monospace;">${fmtPrice(r.entryPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;">${fmtPrice(r.takeProfitPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#ef4444;">${fmtPrice(r.stopLossPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;font-weight:600;">${fmtPct(r.targetReturn)}</td>
        <td style="font-size:11px;color:#4b5563;">${escHtml(r.thesis)}</td>
      </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Buy Signals Report — FinSurfing</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 14px; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #fff; color: #111827; line-height: 1.5;
      padding: 32px 40px; max-width: 1200px; margin: 0 auto;
    }
    .print-btn {
      display: inline-flex; align-items: center; gap: 6px; margin-bottom: 24px;
      padding: 8px 16px; background: #1d4ed8; color: #fff; border: none;
      border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .print-btn:hover { background: #1e40af; }
    .report-header { border-bottom: 2px solid #e5e7eb; padding-bottom: 20px; margin-bottom: 28px; }
    .report-title  { font-size: 26px; font-weight: 800; color: #111827; letter-spacing: -0.5px; }
    .report-subtitle { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 16px; }
    .meta-item { display: flex; flex-direction: column; gap: 2px; }
    .meta-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; }
    .meta-value { font-size: 13px; font-weight: 600; color: #111827; }
    .section { margin-bottom: 32px; }
    .section-title {
      font-size: 13px; font-weight: 800; text-transform: uppercase;
      letter-spacing: 0.08em; color: #374151;
      padding-bottom: 8px; border-bottom: 1px solid #f3f4f6; margin-bottom: 16px;
    }
    .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .overview-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; }
    .overview-card-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 6px; }
    .overview-card-body  { font-size: 13px; color: #111827; line-height: 1.6; }
    .risks-card-body     { font-size: 12px; color: #b45309; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead tr { background: #f3f4f6; }
    th { text-align: left; padding: 8px 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; border-bottom: 1px solid #e5e7eb; }
    td { padding: 9px 10px; border-bottom: 1px solid #f3f4f6; color: #111827; vertical-align: top; }
    tbody tr:hover { background: #f9fafb; }
    tbody tr:last-child td { border-bottom: none; }
    .disclaimer { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; font-size: 11px; color: #9ca3af; line-height: 1.6; margin-top: 32px; }
    .disclaimer strong { color: #6b7280; }
    @media print {
      body { padding: 16px 20px; }
      .print-btn { display: none !important; }
      table { font-size: 10px; }
      th, td { padding: 6px 7px; }
      @page { margin: 12mm 14mm; size: A4 landscape; }
    }
  </style>
</head>
<body>

  <button class="print-btn" onclick="window.print()">&#x1F5A8;&#xFE0F; Print / Save as PDF</button>

  <div class="report-header">
    <div class="report-title">AI Buy Signals Report</div>
    <div class="report-subtitle">FinSurfing · Claude-Powered Stock, ETF &amp; Crypto Picks</div>
    <div class="report-meta">
      <div class="meta-item">
        <span class="meta-label">Generated</span>
        <span class="meta-value">${escHtml(fmtDate(generatedAt))}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Total Picks</span>
        <span class="meta-value">${recommendations.length}</span>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Market Context</div>
    <div class="overview-grid">
      <div class="overview-card">
        <div class="overview-card-title">Market Outlook</div>
        <div class="overview-card-body">${escHtml(marketOutlook)}</div>
      </div>
      ${keyRisks ? `
      <div class="overview-card">
        <div class="overview-card-title">Key Risks</div>
        <div class="risks-card-body">${escHtml(keyRisks)}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Recommendations</div>
    <table>
      <thead>
        <tr>
          <th style="width:60px;">Symbol</th>
          <th style="width:120px;">Name</th>
          <th style="width:48px;">Type</th>
          <th style="width:48px;text-align:center;">Period</th>
          <th style="width:90px;">Sector</th>
          <th style="width:52px;text-align:center;">Risk</th>
          <th style="width:76px;text-align:right;">Entry Price</th>
          <th style="width:80px;text-align:right;">Take Profit</th>
          <th style="width:76px;text-align:right;">Stop Loss</th>
          <th style="width:64px;text-align:right;">Target %</th>
          <th>Thesis</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="disclaimer">
    <strong>Disclaimer:</strong> This report is generated by AI for <strong>informational purposes only</strong>
    and does <strong>not</strong> constitute financial, investment, or trading advice. AI-generated picks and
    price targets are estimates and do <strong>not</strong> guarantee future results. Past performance is not
    indicative of future returns. Always conduct your own independent research and consult a qualified financial
    adviser before making any investment decisions. FinSurfing accepts no liability for investment outcomes.
  </div>

  <script>setTimeout(function(){ try{ window.print() }catch(e){} }, 500)</script>
</body>
</html>`
}

export function exportBuySignalsToPDF(recs) {
  if (!recs) {
    console.warn('exportBuySignalsToPDF: no recs provided')
    return null
  }

  const html = buildBuySignalsHTML(recs)

  const newWindow = window.open('', '_blank')
  if (!newWindow) {
    window.alert(
      'Pop-up blocked. Please allow pop-ups for this site and try again.\n\n' +
      'Or use your browser\'s "Print" shortcut (Ctrl+P / Cmd+P) directly.'
    )
    return null
  }

  newWindow.document.open()
  newWindow.document.write(html)
  newWindow.document.close()

  return newWindow
}
