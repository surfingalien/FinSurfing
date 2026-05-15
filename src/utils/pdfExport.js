/**
 * pdfExport.js — Generate a print-friendly HTML report for AI Brain analysis.
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
  if (val == null) return '—'
  return `$${Number(val).toFixed(2)}`
}

function fmtPct(val, sign = true) {
  if (val == null) return '—'
  const n = Number(val)
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

/* ── Score color (for HTML) ──────────────────────────────── */
function scoreColor(score) {
  if (score == null) return '#6b7280'
  if (score >= 75) return '#10b981'
  if (score >= 55) return '#f59e0b'
  return '#ef4444'
}

/* ── Verdict color ───────────────────────────────────────── */
function verdictColor(verdict) {
  if (!verdict) return '#6b7280'
  const v = verdict.toLowerCase()
  if (v.includes('strong buy')) return '#10b981'
  if (v.includes('buy'))        return '#34d399'
  if (v.includes('moderate'))   return '#f59e0b'
  return '#6b7280'
}

/* ── Agent notes rows ────────────────────────────────────── */
function buildAgentNotesRows(agentNotes) {
  if (!agentNotes) return ''
  const agents = [
    { key: 'fundamentalAnalyst', label: 'Fundamental',  color: '#60a5fa' },
    { key: 'technicalAnalyst',   label: 'Technical',    color: '#22d3ee' },
    { key: 'sentimentAnalyst',   label: 'Sentiment',    color: '#a78bfa' },
    { key: 'macroEconomist',     label: 'Macro',        color: '#fbbf24' },
    { key: 'riskManager',        label: 'Risk',         color: '#f87171' },
  ]

  return agents.map(a => {
    const note = agentNotes[a.key]
    if (!note) return ''
    return `
      <div class="agent-note" style="border-left: 3px solid ${a.color};">
        <div class="agent-label" style="color: ${a.color};">${escHtml(a.label)} Agent</div>
        <div class="agent-text">${escHtml(note)}</div>
      </div>`
  }).join('')
}

/* ── Stock table rows ────────────────────────────────────── */
function buildStockRows(rankedStocks) {
  if (!Array.isArray(rankedStocks) || rankedStocks.length === 0) {
    return '<tr><td colspan="12" style="text-align:center;color:#9ca3af;padding:20px;">No ranked stocks available.</td></tr>'
  }

  return rankedStocks.map(s => {
    const scoreClr  = scoreColor(s.compositeScore)
    const verdictClr = verdictColor(s.agentVerdict)
    return `
      <tr>
        <td style="text-align:center;font-weight:700;">${escHtml(s.rank)}</td>
        <td style="font-family:monospace;font-weight:700;">${escHtml(s.symbol)}</td>
        <td>${escHtml(s.name)}</td>
        <td>${escHtml(s.sector)}</td>
        <td style="text-align:center;font-weight:700;color:${scoreClr};">${s.compositeScore ?? '—'}</td>
        <td style="color:${verdictClr};font-weight:600;">${escHtml(s.agentVerdict)}</td>
        <td style="text-align:right;font-family:monospace;">${fmtPrice(s.currentPrice)}</td>
        <td style="text-align:right;font-family:monospace;">${fmtPrice(s.entryPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;">${fmtPrice(s.takeProfitPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#ef4444;">${fmtPrice(s.stopLossPrice)}</td>
        <td style="text-align:right;font-family:monospace;color:#10b981;font-weight:600;">${fmtPct(s.targetReturn)}</td>
        <td style="text-align:center;">${escHtml(s.horizon)}</td>
      </tr>`
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

  const agentNoteRows = buildAgentNotesRows(agentNotes)
  const stockRows     = buildStockRows(rankedStocks)
  const universeStr   = Array.isArray(universeAnalyzed) ? universeAnalyzed.join(', ') : '—'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Brain Analysis Report — FinSurfing</title>
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 14px; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #fff;
      color: #111827;
      line-height: 1.5;
      padding: 32px 40px;
      max-width: 1100px;
      margin: 0 auto;
    }

    /* ── Print button (hidden on print) ── */
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

    /* ── Header ── */
    .report-header {
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .report-title {
      font-size: 26px;
      font-weight: 800;
      color: #111827;
      letter-spacing: -0.5px;
    }
    .report-subtitle {
      font-size: 13px;
      color: #6b7280;
      margin-top: 4px;
    }
    .report-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 24px;
      margin-top: 16px;
    }
    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .meta-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9ca3af;
    }
    .meta-value {
      font-size: 13px;
      font-weight: 600;
      color: #111827;
    }

    /* ── Section ── */
    .section {
      margin-bottom: 32px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #374151;
      padding-bottom: 8px;
      border-bottom: 1px solid #f3f4f6;
      margin-bottom: 16px;
    }

    /* ── Market overview cards ── */
    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .overview-card {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 16px;
    }
    .overview-card-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6b7280;
      margin-bottom: 6px;
    }
    .overview-card-main {
      font-size: 15px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 4px;
    }
    .overview-card-body {
      font-size: 12px;
      color: #4b5563;
      line-height: 1.6;
    }

    /* ── Universe ── */
    .universe-text {
      font-size: 11px;
      color: #9ca3af;
      margin-top: 8px;
      font-family: monospace;
    }

    /* ── Agent notes ── */
    .agent-notes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }
    .agent-note {
      background: #f9fafb;
      border-radius: 8px;
      padding: 12px 12px 12px 14px;
    }
    .agent-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 5px;
    }
    .agent-text {
      font-size: 11px;
      color: #4b5563;
      line-height: 1.55;
    }

    /* ── Ranked stocks table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead tr {
      background: #f3f4f6;
    }
    th {
      text-align: left;
      padding: 8px 10px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6b7280;
      border-bottom: 1px solid #e5e7eb;
    }
    td {
      padding: 9px 10px;
      border-bottom: 1px solid #f3f4f6;
      color: #111827;
      vertical-align: middle;
    }
    tbody tr:hover { background: #f9fafb; }
    tbody tr:last-child td { border-bottom: none; }

    /* ── Disclaimer ── */
    .disclaimer {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 11px;
      color: #9ca3af;
      line-height: 1.6;
      margin-top: 32px;
    }
    .disclaimer strong { color: #6b7280; }

    /* ── Print styles ── */
    @media print {
      body { padding: 16px 20px; }
      .print-btn { display: none !important; }
      table { font-size: 10px; }
      th, td { padding: 6px 7px; }
      .overview-grid { grid-template-columns: 1fr 1fr; }
      .agent-notes-grid { grid-template-columns: repeat(3, 1fr); }
      .section { margin-bottom: 20px; }
      .overview-card, .agent-note, .disclaimer { border: 1px solid #d1d5db; }
      a { text-decoration: none; color: inherit; }
      @page {
        margin: 12mm 14mm;
        size: A4 landscape;
      }
    }
  </style>
</head>
<body>

  <!-- Print button -->
  <button class="print-btn" onclick="window.print()">
    &#x1F5A8;&#xFE0F; Print / Save as PDF
  </button>

  <!-- ── Report header ── -->
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

  <!-- ── Market overview ── -->
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

  <!-- ── Agent notes ── -->
  ${agentNoteRows ? `
  <div class="section">
    <div class="section-title">Agent Market Views</div>
    <div class="agent-notes-grid">
      ${agentNoteRows}
    </div>
  </div>` : ''}

  <!-- ── Ranked stocks ── -->
  <div class="section">
    <div class="section-title">
      Ranked Stock Picks — ${escHtml(horizonLabel(horizon))} Horizon
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:36px;">Rank</th>
          <th style="width:60px;">Symbol</th>
          <th>Name</th>
          <th>Sector</th>
          <th style="width:46px;text-align:center;">Score</th>
          <th style="width:96px;">Verdict</th>
          <th style="width:80px;text-align:right;">Curr. Price</th>
          <th style="width:80px;text-align:right;">Entry</th>
          <th style="width:80px;text-align:right;">Target</th>
          <th style="width:80px;text-align:right;">Stop Loss</th>
          <th style="width:72px;text-align:right;">Return %</th>
          <th style="width:52px;text-align:center;">Horizon</th>
        </tr>
      </thead>
      <tbody>
        ${stockRows}
      </tbody>
    </table>
  </div>

  <!-- ── Disclaimer ── -->
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

/**
 * exportAnalysisToPDF(analysis, horizon)
 *
 * Builds a print-ready HTML page for the AI Brain analysis and opens it in a
 * new browser tab. Automatically triggers window.print() after 500 ms.
 *
 * @param {object} analysis  - AI Brain response (rankedStocks, marketRegime, …)
 * @param {string} horizon   - '3m' | '6m' | '12m'
 * @returns {Window|null}    - The new window reference, or null if blocked.
 */
export function exportAnalysisToPDF(analysis, horizon) {
  if (!analysis) {
    console.warn('exportAnalysisToPDF: no analysis provided')
    return null
  }

  const html = buildHTML(analysis, horizon)

  const newWindow = window.open('', '_blank')
  if (!newWindow) {
    // Popup was blocked — alert the user
    alert(
      'Pop-up blocked. Please allow pop-ups for this site and try again.\n\n' +
      'Or use your browser\'s "Print" shortcut (Ctrl+P / Cmd+P) directly.'
    )
    return null
  }

  newWindow.document.open()
  newWindow.document.write(html)
  newWindow.document.close()

  // Auto-trigger the print dialog after the page has rendered
  setTimeout(() => {
    try {
      newWindow.print()
    } catch (e) {
      // Some browsers disallow programmatic print from cross-origin context;
      // the user can still use the on-page Print button.
      console.warn('exportAnalysisToPDF: auto-print failed', e)
    }
  }, 500)

  return newWindow
}
