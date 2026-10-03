'use strict'

/**
 * lib/system-status.js — "is it working?", answered check by check.
 *
 * The research pipeline has many moving parts (market data, the AI model,
 * persistence, scheduled jobs, the calibration record), and a failure in any
 * of them is silent from the UI: a scan still renders, just on worse inputs.
 * This turns the raw facts the route gathers into a list of checks, each
 * { id, label, status: ok|warn|fail, detail, fix? }, plus an overall status.
 * No check calls an LLM or spends quota beyond one probe quote.
 *
 * Pure. Tests: tests/system-status.test.js
 */

const HOUR = 3600000
const DAY  = 24 * HOUR

const ago = (ms) => {
  if (!(ms >= 0)) return 'unknown'
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))} min ago`
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h ago`
  return `${Math.round(ms / DAY)} days ago`
}

function check(id, label, status, detail, fix = null) {
  return { id, label, status, detail, ...(fix ? { fix } : {}) }
}

/**
 * @param {object} f  facts gathered by the route
 * @param {number} [now]
 */
function evaluateStatus(f, now = Date.now()) {
  const checks = []

  // 1. Market data — the thing every other check depends on.
  const q = f.probeQuote
  if (q?.price > 0) {
    checks.push(check('market-data', 'Live market data', 'ok', `${q.symbol} $${q.price} from the quote feed just now`))
  } else if (f.probeBars?.lastClose > 0) {
    checks.push(check('market-data', 'Live market data', 'warn',
      `No live quote; daily bars work (last close ${f.probeBars.asOf}). Scans fall back to last close.`,
      'Add or check the Finnhub / FMP keys (API Keys page, or FINNHUB_API_KEY / FMP_API_KEY on the server).'))
  } else {
    checks.push(check('market-data', 'Live market data', 'fail',
      'No quote and no price history for the probe symbol — scans will refuse to run rather than guess prices.',
      'Set market-data keys: FINNHUB_API_KEY and/or FMP_API_KEY.'))
  }

  // 2. AI model availability (key presence only — never spends a call).
  const ai = f.ai || {}
  if (ai.claude && !ai.paused) checks.push(check('ai', 'AI model', 'ok', `Claude available${ai.groq ? ', Groq second opinion on' : ''}`))
  else if (ai.groq) checks.push(check('ai', 'AI model', 'warn', ai.paused ? `Claude paused until ${ai.pausedUntil}; running on Groq only` : 'Groq only (no Anthropic key)'))
  else checks.push(check('ai', 'AI model', 'fail', 'No AI provider configured', 'Set ANTHROPIC_API_KEY (or GROQ_API_KEY).'))

  // 3. Optional evidence sources.
  checks.push(f.keys?.fred
    ? check('macro', 'Macro data (FRED)', 'ok', 'Configured')
    : check('macro', 'Macro data (FRED)', 'warn', 'Not configured — scans and theses run without the macro regime', 'Set FRED_API_KEY (free).'))
  if (!f.keys?.fmp) {
    checks.push(check('fundamentals', 'Fundamentals & movers (FMP)', 'warn', "Not configured — no valuation evidence and no 'today's movers' in scan lists", 'Set FMP_API_KEY.'))
  } else if (f.fmpProbe && !f.fmpProbe.ok) {
    // Key set but refused — the case "Configured" used to hide.
    checks.push(check('fundamentals', 'Fundamentals & movers (FMP)', 'fail',
      `Key is set but FMP refused it: ${f.fmpProbe.error}`,
      'Check the FMP key and plan at financialmodelingprep.com (a browser-saved key on the API Keys page overrides the server key).'))
  } else {
    checks.push(check('fundamentals', 'Fundamentals & movers (FMP)', 'ok', f.fmpProbe ? 'Answering (live probe)' : 'Configured'))
  }

  // Email — sign-up codes and password resets depend on it, and both screens
  // say "sent" whether or not anything left the server.
  const em = f.email
  if (em) {
    if (em.provider === 'none') {
      checks.push(check('email', 'Email (sign-up codes, password reset)', 'fail',
        'No email provider configured — verification codes and reset links are never sent',
        'Set RESEND_API_KEY (and RESEND_FROM on a domain verified in Resend), or SMTP_HOST/SMTP_USER/SMTP_PASS. Meanwhile ADMIN_EMAIL + ADMIN_PASSWORD give the operator a verified login.'))
    } else if (em.provider === 'resend' && em.fromDefault) {
      checks.push(check('email', 'Email (sign-up codes, password reset)', 'warn',
        `Resend is configured but sends as the default ${em.from}; Resend rejects senders on unverified domains`,
        'Set RESEND_FROM to an address on a domain you verified in Resend (failures are logged as "[EMAIL] send failed").'))
    } else if (f.appUrl === false) {
      checks.push(check('email', 'Email (sign-up codes, password reset)', 'warn',
        `${em.provider} configured, but APP_URL is not set — reset links point to localhost`,
        'Set APP_URL to the site address, e.g. https://finsurfing-production.up.railway.app'))
    } else {
      checks.push(check('email', 'Email (sign-up codes, password reset)', 'ok', `${em.provider}, sending as ${em.from}`))
    }
  }

  // 4. Persistence — without it every learning number resets on deploy.
  const p = f.persistence
  const heldBack = (p?.files || []).filter(x => /not mirrored/.test(x.note || ''))
  checks.push(p?.enabled && heldBack.length
    ? check('persistence', 'Learning data saved across deploys', 'warn',
        `Mirrored to Postgres, but ${heldBack.map(x => x.name).join(', ')} ${heldBack.length > 1 ? 'are' : 'is'} damaged on disk and held back so the good stored copy is not overwritten`,
        'A copy of the damaged file is kept beside it as *.damaged-<time>; check the "[atomic-write]" / "[durable-files]" log lines. Restarting restores the stored copy.')
    : p?.enabled
    ? check('persistence', 'Learning data saved across deploys', 'ok', 'Mirrored to Postgres')
    : check('persistence', 'Learning data saved across deploys', 'fail', `Not persisted (${p?.reason || 'unknown'}) — the track record resets at every deploy`, 'Attach Postgres (DATABASE_URL) and check the startup log for "[durable-files]".'))

  // 5. Symbol index — feeds the rotating part of each scan's list.
  checks.push(f.symbolIndex?.loaded
    ? check('symbol-index', 'Symbol index (for fresh scan lists)', 'ok', `${Object.values(f.symbolIndex.counts || {}).reduce((a, b) => a + b, 0).toLocaleString('en-US')} symbols`)
    : check('symbol-index', 'Symbol index (for fresh scan lists)', 'warn', 'Not loaded yet — scans rotate through the core lists only until it is'))

  // 6. Most recent scan.
  if (f.lastScanAt) {
    const age = now - new Date(f.lastScanAt).getTime()
    checks.push(check('last-scan', 'Your latest AI Brain scan', age > DAY ? 'warn' : 'ok',
      `${ago(age)}${f.lastScanSymbols ? ` · ${f.lastScanSymbols} symbols` : ''}${f.lastScanDataAge ? ` · prices: ${f.lastScanDataAge}` : ''}`))
  } else {
    checks.push(check('last-scan', 'Your latest AI Brain scan', 'warn', 'No completed scan since the last deploy'))
  }

  // 7. Scheduled jobs that keep the record honest (in-memory: since this boot).
  for (const j of f.jobs || []) {
    const r = j.result || {}
    if (r.status === 'error' || r.error) {
      checks.push(check(`job:${j.id}`, j.name, 'fail', `Last run failed ${ago(now - (r.failedAt || r.lastRun))}: ${String(r.error).slice(0, 160)}`))
    } else if (r.lastRun) {
      checks.push(check(`job:${j.id}`, j.name, 'ok', `Ran ${ago(now - r.lastRun)}`))
    } else {
      checks.push(check(`job:${j.id}`, j.name, 'ok', `Scheduled (${j.scheduleText || 'not yet due'}) — has not run since this deploy`))
    }
  }

  // 8. The calibration record itself.
  const rec = f.record || {}
  if (!rec.logged) {
    checks.push(check('record', 'Prediction record', 'warn', 'No predictions logged yet — every actionable scan pick is recorded and scored at 7 and 30 days'))
  } else {
    const next = rec.nextResolutionAt ? ` · next outcome due ${new Date(rec.nextResolutionAt).toISOString().slice(0, 10)}` : ''
    checks.push(check('record', 'Prediction record', 'ok', `${rec.logged} picks logged, ${rec.resolved} scored against real prices${next}`))
  }

  // 9. Do the self-learned findings hold up? (lib/learning-health.js)
  const lh = f.learningHealth
  if (lh?.available) {
    const dropped = Object.entries(lh.flags || {}).filter(([, v]) => !v.keep).map(([k, v]) => `${k} (${v.verdict})`)
    const rejected = lh.learnings?.rejected?.length || 0
    const e = lh.effect || {}
    const pc = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`)
    if (lh.withheld) {
      checks.push(check('learning-health', 'Self-learned findings', 'warn',
        `Withheld from scans: picks made with them beat the benchmark ${pc(e.on?.rate)} of the time (n=${e.on?.n}) vs ${pc(e.off?.rate)} without (n=${e.off?.n}), p=${e.p}. ${e.caveat}`,
        'Nothing to do — they return automatically once picks made without them stop doing better.'))
    } else {
      const effect = e.verdict === 'insufficient' ? `with vs without not measurable yet (${e.reason})`
        : `picks made with them: ${pc(e.on?.rate)} vs ${pc(e.off?.rate)} without (${e.verdict}, p=${e.p})`
      const parts = [`${lh.learnings?.kept ?? 0} finding(s) cite a statistic that holds them up`]
      if (rejected) parts.push(`${rejected} dropped (uncited or unsupported)`)
      if (dropped.length) parts.push(`flags not established: ${dropped.join(', ')}`)
      parts.push(effect)
      checks.push(check('learning-health', 'Self-learned findings', 'ok', parts.join(' · ')))
    }
  }

  const rank = { ok: 0, warn: 1, fail: 2 }
  const worst = checks.reduce((w, c) => (rank[c.status] > rank[w] ? c.status : w), 'ok')
  return { overall: worst, checkedAt: new Date(now).toISOString(), checks }
}

/** Counts from the prediction log for the record check. Pure. */
function recordFacts(predictions, now = Date.now()) {
  const logged = predictions.length
  const resolved = predictions.filter(r => r.price7d != null || r.price30d != null).length
  const pending = predictions
    .filter(r => r.price7d == null)
    .map(r => new Date(r.generatedAt).getTime() + 7 * DAY)
    .filter(t => Number.isFinite(t) && t > now - DAY)
    .sort((a, b) => a - b)
  return { logged, resolved, nextResolutionAt: pending[0] ?? null }
}

module.exports = { evaluateStatus, recordFacts }
