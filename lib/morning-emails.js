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

// ── Second Brain notes from the holdings research ────────────────────────────

const VERDICT_TAG = 'verdict:'
const verdictLabel = v => (v === 'actionable' ? 'Actionable long' : 'No trade')

/** The verdict a saved Research Desk note recorded (from its tag), or null. */
function verdictOfNote(note) {
  const tag = (note?.tags || []).find(t => String(t).startsWith(VERDICT_TAG))
  return tag ? tag.slice(VERDICT_TAG.length) : null
}

/**
 * A Research Desk thesis as a Second Brain note: title, tags (including the
 * verdict, so the next run can say whether it changed) and markdown body.
 */
function thesisNote({ symbol, data, dateStr, appUrl }) {
  const j = data?.judgement || {}
  const verdict = j.verdict === 'actionable' ? 'actionable' : 'no-trade'
  const z = j.zones
  const lines = [
    `**Verdict: ${verdictLabel(verdict)}**${data?.lastPrice != null ? ` · last price ${money(data.lastPrice)}` : ''}`,
    j.summary ? `\n${j.summary}` : '',
    (j.reasons || []).length ? `\n**Why:** ${j.reasons.join('; ')}` : '',
    z ? `\n**Plan:** entry ${money(z.entryLow)}–${money(z.entryHigh)} · target ${money(z.target)} (${pct(z.targetReturn, '+')}) · stop ${money(z.stop)} (${pct(z.stopLoss, '−')}) · ${j.horizonDays} days` : '',
    (j.bull || []).length ? `\n**Bull case (checked against its evidence)**\n${j.bull.map(c => `- ${c.claim}`).join('\n')}` : '',
    (j.bear || []).length ? `\n**Bear case (checked against its evidence)**\n${j.bear.map(c => `- ${c.claim}`).join('\n')}` : '',
    j.invalidation ? `\n**Wrong if:** ${j.invalidation}` : '',
    `\n[Open in the Research Desk](${appUrl}/#/research-desk/${encodeURIComponent(symbol)})`,
  ]
  return {
    title: `Research Desk · ${symbol} · ${dateStr} · ${verdictLabel(verdict)}`,
    content: lines.filter(Boolean).join('\n'),
    tags: ['research-desk', `${VERDICT_TAG}${verdict}`],
    verdict,
  }
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
  const sections = results.map(({ symbol, data, error, previous, ownNote }) => {
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
    const today = actionable ? 'actionable' : 'no-trade'
    const since = previous?.verdict
      ? note(previous.verdict === today
        ? `Unchanged since the last check (${esc(previous.date)}).`
        : `<strong>Changed</strong> since ${esc(previous.date)}: was ${esc(verdictLabel(previous.verdict))}, now ${esc(verdictLabel(today))}.`, previous.verdict === today ? '#64748b' : '#7c3aed')
      : note('First check of this holding.', '#94a3b8')
    const mine = ownNote?.title
      ? note(`Your latest note: “${esc(ownNote.title)}” (${esc(ownNote.date)}). It was shown to the analyst as context; no claim can rest on it.`, '#475569')
      : ''
    return section(`${head}<div style="margin:6px 0;">${badge}</div>
      ${since}${mine}
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
    footer: 'Sent automatically by FinSurf at 7:45 AM ET, Mon–Fri. Each thesis is also saved under Research Desk → Theses and as a note in your Second Brain.',
  })
}

// ── Sunday Second Brain email ────────────────────────────────────────────────

// Just enough markdown for a model-written synthesis: headings, bullets, bold.
// Everything is escaped FIRST, so no tag the model wrote survives.
function mdToHtml(md) {
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*(\S[^*]*?)\*(?=\W|$)/g, '$1<em>$2</em>')
  const out = []
  let list = false
  for (const raw of esc(md).split('\n')) {
    const line = raw.trim()
    const bullet = /^[-*] +(.*)$/.exec(line)
    if (!bullet && list) { out.push('</ul>'); list = false }
    if (bullet) {
      if (!list) { out.push('<ul style="margin:4px 0 8px 18px;padding:0;color:#334155;font-size:12px;">'); list = true }
      out.push(`<li>${inline(bullet[1])}</li>`)
    } else if (/^#{1,2} /.test(line)) out.push(`<div style="font-size:14px;font-weight:700;color:#0f172a;margin:12px 0 4px;">${inline(line.replace(/^#+ /, ''))}</div>`)
    else if (/^#{3,} /.test(line)) out.push(`<div style="font-size:12px;font-weight:700;color:#0f172a;margin:10px 0 2px;">${inline(line.replace(/^#+ /, ''))}</div>`)
    else if (line) out.push(`<div style="color:#334155;font-size:12px;margin:4px 0;line-height:1.5;">${inline(line)}</div>`)
  }
  if (list) out.push('</ul>')
  return out.join('\n')
}

/** First Sunday of the month (in New York) — the routine's monthly step. */
function isFirstWeekOfMonth(date = new Date()) {
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric' }).format(date))
  return day <= 7
}

/**
 * @param {object} o
 * @param {object|null} o.synthesis   the note weekly-synthesis saved, or null
 * @param {string|null} o.synthesisNote  why there is none ("no notes this week", an error)
 * @param {object|null} o.lint        lint response { issues, score, noteCount }
 * @param {string|null} o.lintError
 * @param {{symbol:string, count:number}[]|null} o.consolidate  monthly: holdings with enough notes to merge; null on other weeks
 */
function buildSecondBrainWeeklyHtml({ dateStr, synthesis, synthesisNote, lint, lintError, consolidate, appUrl }) {
  const brain = `${appUrl}/#/second-brain`
  const check = (done, text) => `<div style="font-size:12px;color:#334155;margin:3px 0;">${done ? '✅' : '⬜'} ${text}</div>`
  const routine = section(`<div style="font-size:14px;font-weight:700;color:#0f172a;">Your research routine</div>
    ${check(true, '<strong>Weekly:</strong> Weekly Synthesis and Lint — done for you below.')}
    ${check(consolidate != null, consolidate != null
      ? '<strong>Monthly:</strong> Consolidate — the holdings below have enough notes to merge into one thesis.'
      : '<strong>Monthly:</strong> Consolidate — the list comes on the first Sunday of the month.')}
    ${check(false, '<strong>New idea:</strong> Braindump it, then Thinking Partner to stress-test it, then save.')}
    ${check(false, '<strong>Before buying:</strong> Deep Research or Auto Research, then the Research Desk for the checked verdict.')}
    <div style="margin:8px 0 10px;"><a href="${esc(brain)}" style="color:#2563eb;font-size:11px;">Open Second Brain →</a></div>`)

  const synth = section(`<div style="font-size:14px;font-weight:700;color:#0f172a;">This week's synthesis</div>
    ${synthesis?.content ? mdToHtml(synthesis.content) : note(esc(synthesisNote || 'No synthesis this week.'), '#b45309')}`)

  let lintHtml
  if (!lint) lintHtml = note(`Lint did not run: ${esc(lintError || 'unknown error')}`, '#ef4444')
  else {
    const issues = lint.issues || []
    const group = (sev, label, color) => {
      const xs = issues.filter(i => i.severity === sev)
      return xs.length ? `<div style="font-size:12px;font-weight:700;color:${color};margin-top:8px;">${label} (${xs.length})</div>
        <ul style="margin:2px 0 0 16px;padding:0;color:#334155;font-size:11px;">${xs.slice(0, 12).map(i => `<li><strong>${esc(i.title)}</strong> — ${esc(i.message)}</li>`).join('')}</ul>${xs.length > 12 ? note(`…and ${xs.length - 12} more in Second Brain → Lint.`) : ''}` : ''
    }
    lintHtml = `${note(`Health score <strong>${esc(lint.score)}</strong>/100 across ${esc(lint.noteCount)} notes.`, '#0f172a')}
      ${group('error', 'Contradictions', '#dc2626')}${group('warning', 'Needs attention', '#b45309')}${group('info', 'Tidy-ups', '#64748b')}
      ${issues.length ? '' : note('No issues found.', '#059669')}`
  }
  const lintSection = section(`<div style="font-size:14px;font-weight:700;color:#0f172a;">Notes health check (Lint)</div>${lintHtml}`)

  const cons = consolidate == null ? '' : section(`<div style="font-size:14px;font-weight:700;color:#0f172a;">Monthly: consolidate these</div>
    ${consolidate.length
      ? `<ul style="margin:4px 0 8px 16px;padding:0;color:#334155;font-size:12px;">${consolidate.map(c => `<li><strong>${esc(c.symbol)}</strong> — ${esc(c.count)} notes</li>`).join('')}</ul>${note('In Second Brain, open a note on the symbol and press Synthesize to merge them into one up-to-date thesis.')}`
      : note('No holding has 3 or more notes yet — nothing to consolidate this month.')}`)

  return shell({
    title: 'Second Brain Weekly',
    subtitle: dateStr,
    intro: 'Your week of research in one place: what your notes say, what needs fixing, and the routine that keeps every holding\'s thesis current.',
    body: routine + synth + lintSection + cons,
    footer: 'Sent automatically by FinSurf at 9:00 AM ET on Sundays. The synthesis is also saved as a note in your Second Brain.',
  })
}

module.exports = {
  AVOID_VERDICTS, splitBuysAvoids, businessDayIndex, rotateSlice,
  buildPersonaHtml, buildPersonaFailuresHtml, buildHoldingsResearchHtml, esc,
  thesisNote, verdictOfNote,
  mdToHtml, isFirstWeekOfMonth, buildSecondBrainWeeklyHtml,
}
