'use strict'
/**
 * lib/research-report.js — a Research Desk dossier (and its thesis, when one
 * was written) as ONE self-contained HTML page the reader can save, print or
 * send. Built in the browser from what the page already holds: nothing is
 * recomputed and no figure is added — the report is the checked record, not a
 * new analysis. Every value is HTML-escaped (evidence text includes SEC
 * filing excerpts and model output).
 *
 * Shared with the browser (tools/vite-shared-cjs.mjs:SHARED_CJS), so it must
 * stay pure and require nothing. Tests: tests/research-report.test.js
 */

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const money = v => (Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : '—')

const VERDICT_TEXT = { actionable: 'Actionable — cleared every check', 'no-trade': 'No trade' }
const VARIANT_TEXT = { stated: 'differs from consensus — stated and checkable', agrees: 'agrees with consensus', unsupported: 'claimed to differ, but did not hold up' }

function claimList(claims, empty) {
  if (!claims?.length) return `<p class="muted">${esc(empty)}</p>`
  return `<ul>${claims.map(c => `<li>${esc(c.claim)} <span class="cite">[${(c.cites || []).map(esc).join(', ')}]</span></li>`).join('')}</ul>`
}

function thesisSection(t) {
  const j = t?.judgement
  if (!j) return '<h2>Thesis</h2><p class="muted">No thesis was written for this report — evidence only.</p>'
  const z = j.zones
  const v = j.variant
  return `
<h2>Thesis <span class="muted">(${esc(t.method || 'single')} · ${esc(String(t.at || '').slice(0, 16).replace('T', ' '))} UTC)</span></h2>
<p class="verdict ${j.verdict === 'actionable' ? 'ok' : 'no'}">${esc(VERDICT_TEXT[j.verdict] || j.verdict)}</p>
${j.summary ? `<p>${esc(j.summary)}</p>` : ''}
${(j.reasons || []).length ? `<ul class="reasons">${j.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
<h3>Bull case (${(j.bull || []).length} verified)</h3>${claimList(j.bull, 'No bull claim survived verification.')}
<h3>Bear case (${(j.bear || []).length} verified)</h3>${claimList(j.bear, 'No bear claim survived verification.')}
${(j.droppedClaims || []).length ? `<h3>Removed by the checks</h3><ul class="muted">${j.droppedClaims.map(c => `<li>[${esc(c.side)}] ${esc(c.claim)} — ${esc(c.reason)}</li>`).join('')}</ul>` : ''}
${v ? `<h3>Variant view — ${esc(VARIANT_TEXT[v.status] || v.status)}</h3>
<p><b>Consensus:</b> ${v.consensus ? `${esc(v.consensus.claim)} <span class="cite">[${(v.consensus.cites || []).map(esc).join(', ')}]</span>` : `<span class="muted">removed (${esc(v.consensusRemoved)})</span>`}</p>
${v.differsOn !== 'none' ? `<p><b>Differs on ${esc(v.differsOn)}:</b> ${v.view ? esc(v.view) : `<span class="muted">removed (${esc(v.viewRemoved)})</span>`}</p>` : ''}
${v.wrongIf ? `<p><b>Wrong if, by ${esc(v.checkBy)}:</b> ${esc(v.wrongIf)}</p>` : ''}` : ''}
${j.invalidation ? `<p><b>Thesis proven wrong if:</b> ${esc(j.invalidation)}</p>` : ''}
${z ? `<h3>Levels (derived from the price and the thesis percentages)</h3>
<table><tr><th>Entry</th><td>${money(z.entryLow)} – ${money(z.entryHigh)}</td></tr>
<tr><th>Target</th><td>${money(z.target)} (+${esc(z.targetReturn)}%)</td></tr>
<tr><th>Stop</th><td>${money(z.stop)} (−${esc(z.stopLoss)}%)</td></tr>
<tr><th>Horizon</th><td>${esc(j.horizonDays)} days</td></tr>
${j.expectedValue ? `<tr><th>Net edge</th><td>${esc(j.expectedValue.netEdge)} (break-even win rate ${esc(j.expectedValue.breakEvenWinProb)}; win rate used ${esc(j.expectedValue.winProbSource)})</td></tr>` : ''}
${j.sizing?.suggestedPct != null ? `<tr><th>Suggested size</th><td>${esc(j.sizing.suggestedPct)}% of the portfolio</td></tr>` : ''}
</table>` : ''}`
}

/** The whole report as an HTML string. dossier = GET …/evidence; thesis = POST …/thesis (or null). Pure. */
function buildReport({ dossier, thesis = null, generatedAt = new Date().toISOString() } = {}) {
  if (!dossier?.symbol) throw new Error('a dossier is required')
  const title = `${dossier.symbol}${dossier.company ? ` · ${dossier.company}` : ''} — research report`
  const evidence = (dossier.evidence || []).map(i => `
<tr><td class="id">${esc(i.id)}</td><td><b>${esc(i.label)}</b>${i.measured === false ? ' <span class="muted">(third-party opinion)</span>' : ''}${i.citable === false ? ' <span class="muted">(context, not citable)</span>' : ''}<br>${esc(i.text)}${i.source ? `<div class="src">Source: ${esc(i.source)}</div>` : ''}</td></tr>`).join('')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:860px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}h3{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #e2e8f0;padding:6px 8px;vertical-align:top;text-align:left}th{width:140px;color:#475569;font-weight:600}
.id{width:42px;color:#2563eb;font-weight:600}.muted{color:#64748b}.cite{color:#2563eb;font-size:12px}.src{color:#64748b;font-size:12px;margin-top:2px}
.verdict{font-weight:600}.verdict.ok{color:#047857}.verdict.no{color:#b45309}.reasons{color:#475569}
footer{margin-top:32px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:8px}
@media print{body{margin:0}}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="muted">Last close ${money(dossier.lastPrice)} on ${esc(dossier.asOf)} · report generated ${esc(String(generatedAt).slice(0, 16).replace('T', ' '))} UTC by FinSurfing Research Desk</p>
${thesisSection(thesis)}
<h2>Evidence (${(dossier.evidence || []).length} items)</h2>
<p class="muted">Gathered and computed in code. A thesis may use only these items; every claim above was checked against the items it cites.</p>
<table>${evidence}</table>
${(dossier.gaps || []).length ? `<h3>Not available for this report</h3><ul class="muted">${dossier.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
<footer>Research support, not investment advice. Figures are as of the dates shown; third-party opinions are marked as such. Outcomes of past theses are tracked on the Research Desk (My theses, Track record).</footer>
</body></html>`
}

/** A safe file name for the report. Pure. */
function reportFileName(symbol, date = new Date()) {
  return `${String(symbol || 'report').replace(/[^A-Za-z0-9.-]/g, '')}-research-${new Date(date).toISOString().slice(0, 10)}.html`
}

module.exports = { buildReport, reportFileName, esc }
