'use strict'

/**
 * lib/morning-emails.js
 *
 * Pure parts of the morning emails sent by lib/scheduled-jobs.js. No network,
 * no model: the jobs fetch, these decide what goes in and render it.
 *
 *   splitBuysAvoids   — AI Brain buy / avoid lists merged from several scans
 *   rotateSlice       — which holdings get researched today
 *   businessDayIndex  — a weekday counter, so the rotation never skips names
 *   buildPersonaHtml          — one email per Advisory persona
 *   buildHoldingsResearchHtml — one Research Desk thesis per holding
 *
 * Everything the model wrote is HTML-escaped: it is untrusted text going into
 * an email.
 */

// A "Hold"/"Neutral" decline is not an avoid call — it says there is no trade,
// not that the stock should be kept out of a portfolio.
const AVOID_VERDICTS = new Set(['avoid', 'sell', 'strong sell'])

/**
 * Merge the ranked picks of several AI Brain scans into one buy list and one
 * avoid list. A symbol seen twice keeps its first appearance. Never pads: when
 * the scans declined fewer names than asked for, the list is shorter.
 * @returns {{ buys: object[], avoids: object[], ranked: number, scanned: number }}
 */
function splitBuysAvoids(scans, { buys = 15, avoids = 10 } = {}) {
  const bySymbol = new Map()
  const universe = new Set()
  for (const scan of scans || []) {
    for (const s of scan?.universeRequested || []) universe.add(s)
    for (const s of scan?.rankedStocks || []) {
      if (s?.symbol && !bySymbol.has(s.symbol)) bySymbol.set(s.symbol, s)
    }
  }
  const all = [...bySymbol.values()]
  const score = s => Number(s.compositeScore) || 0
  const isAvoid = s => AVOID_VERDICTS.has(String(s.agentVerdict || '').trim().toLowerCase())
  return {
    // A pick with no `actionable` flag predates the coherence gate: a buy.
    buys:   all.filter(s => s.actionable !== false && !isAvoid(s)).sort((a, b) => score(b) - score(a)).slice(0, buys),
    avoids: all.filter(isAvoid).sort((a, b) => score(a) - score(b)).slice(0, avoids),
    ranked: all.length,
    scanned: universe.size || all.length,
  }
}

/**
 * Weekdays since Mon 5 Jan 1970. Saturday and Sunday share Friday's index, so
 * a job that runs Mon–Fri advances by exactly one per run.
 */
function businessDayIndex(date = new Date()) {
  const days = Math.floor(date.getTime() / 86_400_000) - 4 // 1970-01-05 is a Monday
  const week = Math.floor(days / 7)
  const dow  = days - week * 7
  return week * 5 + Math.min(dow, 4)
}

/**
 * `n` symbols for day `day`, walking the sorted list so that consecutive days
 * take consecutive windows and every symbol comes round. All of them when the
 * list is no longer than `n`.
 */
function rotateSlice(symbols, n, day) {
  const list = [...new Set(symbols || [])].sort()
  if (list.length <= n) return list
  const start = (((day * n) % list.length) + list.length) % list.length
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length])
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const money = v => (num(v) == null ? '—' : `$${num(v).toFixed(2)}`)
const pct = (v, sign = '') => (num(v) == null ? '—' : `${sign}${Math.abs(num(v)).toFixed(1)}%`)

function shell({ title, subtitle, intro = '', body, footer }) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:20px 0;">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0" style="max-width:660px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:28px 32px 22px;">
    <div style="color:#00ffcc;font-size:22px;font-weight:800;letter-spacing:-.5px;">FinSurf · ${esc(title)}</div>
    <div style="color:#94a3b8;font-size:12px;margin-top:2px;">${esc(subtitle)}</div>
    ${intro ? `<div style="color:#cbd5e1;font-size:12px;margin-top:12px;line-height:1.5;">${intro}</div>` : ''}
  </td></tr>
  ${body}
  <tr><td style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;">
    <p style="margin:0;color:#94a3b8;font-size:10px;line-height:1.6;">${footer}
      <strong>Not investment advice.</strong> Always do your own research.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

const section = inner => `<tr><td style="padding:18px 32px 6px;border-bottom:1px solid #e2e8f0;">${inner}</td></tr>`
const note = (text, color = '#64748b') => `<div style="color:${color};font-size:12px;margin:6px 0;">${text}</div>`

/**
 * The one email that lists every persona whose run failed today, so a missing
 * persona email never has to be guessed at — and an outage is one message.
 */
function buildPersonaFailuresHtml({ failures, total, dateStr }) {
  return shell({
    title: 'Strategy Desk',
    subtitle: `${failures.length} of ${total} persona run(s) failed · ${dateStr}`,
    intro: 'These personas sent no email today. The rest arrived separately.',
    body: failures.map(f => section(`<div style="font-size:14px;font-weight:700;color:#0f172a;">${esc(f.persona.emoji)} ${esc(f.persona.name)}</div>${note(esc(f.error), '#ef4444')}`)).join(''),
    footer: 'Sent automatically by FinSurf after the 7:00 AM ET persona runs, Mon–Fri.',
  })
}

/**
 * One persona's email. Sent even when the persona abstained — no pick
 * clearing the edge gate is a real answer.
 * @param {object} o
 * @param {object} o.persona   lib/investor-personas.js entry
 * @param {object} o.data      POST /api/recommendations response
 * @param {string} o.dateStr
 * @param {number} [o.maxPicks]
 */
function buildPersonaHtml({ persona, data, dateStr, maxPicks = 10 }) {
  const shellFor = (body, intro) => shell({
    title: `${persona.emoji} ${persona.name}`,
    subtitle: `${persona.style} · ${dateStr}`,
    intro,
    body,
    footer: 'Sent automatically by FinSurf at 7:00 AM ET, Mon–Fri, one email per investor persona.',
  })
  const recs = Array.isArray(data?.recommendations) ? data.recommendations : []
  const intro = `${data?.marketOutlook ? `${esc(data.marketOutlook)} ` : ''}Only picks with a positive expected edge after costs are shown. Net edge = expected gain per unit risked, after costs.`
  if (!recs.length) {
    return shellFor(section(note('No pick cleared the expected-value gate today, so this persona abstained. That is a real answer, not an error.', '#b45309')), intro)
  }
  const rows = recs.slice(0, maxPicks).map((r, i) => {
      const edge = num(r.expectedValue?.netEdge)
      return `<tr style="background:${i % 2 ? '#f1f5f9' : '#f8fafc'};">
        <td style="padding:7px 6px;font-weight:700;color:#0f172a;font-size:12px;">${esc(r.symbol)}<div style="color:#64748b;font-size:10px;font-weight:400;">${esc((r.name || '').slice(0, 24))}</div></td>
        <td style="padding:7px 6px;font-size:11px;color:#334155;">${money(r.entryPrice)}</td>
        <td style="padding:7px 6px;font-size:11px;color:#10b981;">${money(r.takeProfitPrice)}<div style="font-size:10px;">${pct(r.targetReturn, '+')}</div></td>
        <td style="padding:7px 6px;font-size:11px;color:#ef4444;">${money(r.stopLossPrice)}<div style="font-size:10px;">${pct(r.stopLoss, '−')}</div></td>
        <td style="padding:7px 6px;font-size:11px;color:#334155;">${edge == null ? '—' : `${(edge * 100).toFixed(2)}%`}</td>
      </tr>
      <tr style="background:${i % 2 ? '#f1f5f9' : '#f8fafc'};border-bottom:1px solid #e2e8f0;"><td colspan="5" style="padding:0 6px 8px;color:#475569;font-size:10px;">${esc(r.thesis || '')}</td></tr>`
  }).join('')
  const more = recs.length > maxPicks ? note(`${recs.length - maxPicks} more pick(s) in the app's Advisory journal.`) : ''
  return shellFor(section(`
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;margin:8px 0;">
      <thead><tr style="background:#0f172a;">
        ${['Pick', 'Entry', 'Target', 'Stop', 'Net edge'].map(h => `<th style="padding:6px;color:#94a3b8;font-size:9px;text-transform:uppercase;text-align:left;">${h}</th>`).join('')}
      </tr></thead><tbody>${rows}</tbody>
    </table>${more}`), intro)
}

/**
 * @param {object} o
 * @param {{symbol:string, data?:object, error?:string}[]} o.results  one per holding researched today
 * @param {string[]} o.holdings   every holding, so the email can say what is next
 * @param {string}   o.dateStr
 * @param {string}   o.appUrl     base URL for the Research Desk deep links
 */
function buildHoldingsResearchHtml({ results, holdings, dateStr, appUrl }) {
  const done = new Set(results.map(r => r.symbol))
  const sections = results.map(({ symbol, data, error }) => {
    const link = `${appUrl}/#/research-desk/${encodeURIComponent(symbol)}`
    const head = `<div style="font-size:15px;font-weight:700;color:#0f172a;">${esc(symbol)}
      ${data?.company ? `<span style="font-size:11px;font-weight:400;color:#64748b;margin-left:6px;">${esc(data.company)}</span>` : ''}
      ${data?.lastPrice != null ? `<span style="font-size:11px;font-weight:600;color:#334155;margin-left:6px;">${money(data.lastPrice)}</span>` : ''}</div>`
    if (error) return section(head + note(`Research failed today: ${esc(error)}`, '#ef4444'))
    const j = data?.judgement || {}
    const actionable = j.verdict === 'actionable'
    const badge = actionable
      ? '<span style="background:#10b98118;color:#059669;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">Actionable long</span>'
      : '<span style="background:#f59e0b18;color:#b45309;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">No trade</span>'
    const claims = (list, color, label) => (list || []).length
      ? `<div style="font-size:11px;font-weight:700;color:${color};margin-top:8px;">${label}</div><ul style="margin:2px 0 0 16px;padding:0;color:#334155;font-size:11px;">${list.slice(0, 3).map(c => `<li>${esc(c.claim)}</li>`).join('')}</ul>`
      : ''
    const z = j.zones
    const plan = z
      ? note(`Entry ${money(z.entryLow)}–${money(z.entryHigh)} · target ${money(z.target)} (${pct(z.targetReturn, '+')}) · stop ${money(z.stop)} (${pct(z.stopLoss, '−')}) · ${esc(j.horizonDays)} days`, '#0f172a')
      : ''
    const dropped = (j.droppedClaims || []).length
    return section(`${head}<div style="margin:6px 0;">${badge}</div>
      ${j.summary ? note(esc(j.summary), '#334155') : ''}
      ${(j.reasons || []).length ? note(`Why: ${esc(j.reasons.join('; '))}`) : ''}
      ${plan}
      ${claims(j.bull, '#059669', 'Bull case (checked against its evidence)')}
      ${claims(j.bear, '#dc2626', 'Bear case (checked against its evidence)')}
      ${dropped ? note(`${dropped} claim(s) removed for not matching the evidence they cited.`, '#94a3b8') : ''}
      ${j.invalidation ? note(`Wrong if: ${esc(j.invalidation)}`, '#7c3aed') : ''}
      <div style="margin:8px 0 10px;"><a href="${esc(link)}" style="color:#2563eb;font-size:11px;">Open in the Research Desk →</a></div>`)
  }).join('')

  const rest = holdings.filter(s => !done.has(s))
  return shell({
    title: 'Holdings Research',
    subtitle: `${results.length} of your ${holdings.length} holding(s) · ${dateStr}`,
    intro: `Each holding gets a Research Desk thesis: the model writes bull and bear claims citing the evidence, then code keeps only the claims that evidence supports and decides whether a trade clears the expected-value gate.${rest.length ? ` Researched in rotation; still to come: ${esc(rest.join(', '))}.` : ''}`,
    body: sections,
    footer: 'Sent automatically by FinSurf at 7:45 AM ET, Mon–Fri. Each thesis is also saved under Research Desk → Theses.',
  })
}

module.exports = {
  AVOID_VERDICTS, splitBuysAvoids, businessDayIndex, rotateSlice,
  buildPersonaHtml, buildPersonaFailuresHtml, buildHoldingsResearchHtml, esc,
}
