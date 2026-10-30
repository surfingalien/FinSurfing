'use strict'

const crypto     = require('crypto')
const nodemailer = require('nodemailer')

let _mailer = null
function getMailer() {
  if (_mailer) return _mailer
  const hasSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  if (!process.env.RESEND_API_KEY && hasSmtp) {
    _mailer = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return _mailer
}

// A weekday sends ~13 automated emails (10 personas, brief, holdings, any
// failure summary), so one transient provider error used to cost a message
// and, inside the persona loop, every message after it. Resend's 429 (rate
// limit) and 5xx are retried; anything else is a real rejection (unverified
// domain, bad key, bad address) and is thrown at once with Resend's reason.
const ATTEMPTS        = 3
const ATTEMPT_TIMEOUT = 15_000
const BACKOFF_MS      = [1_000, 3_000]
const MAX_RETRY_AFTER = 10_000

// Swappable in tests.
const deps = {
  fetch: (...a) => fetch(...a),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', uarr: '↑', darr: '↓', bull: '•' }

/**
 * Plain-text alternative of an HTML email. An HTML-only message scores worse
 * with spam filters, and a dozen automated HTML-only emails a day from one
 * sender is the pattern they look for. Links keep their URL; table cells are
 * separated so a row of figures stays readable.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !text || text === href ? href : `${text} (${href})`
    })
    // A data row (innermost, ≥2 cells) is one line: block tags inside a cell
    // (a symbol over its name) become spaces. Single-cell and layout rows keep
    // their line breaks.
    .replace(/<tr\b[^>]*>((?:(?!<tr\b|<table\b)[\s\S])*?)<\/tr>/gi, (whole, row) => {
      const cells = row.split(/<\/t[dh]>/i).slice(0, -1)
      if (cells.length < 2) return whole
      return cells.map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ') + '\n'
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|ul|ol|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function retryDelay(res, attempt) {
  const after = Number(res?.headers?.get?.('retry-after'))
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, MAX_RETRY_AFTER)
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
}

async function sendViaResend({ from, to, subject, html, text }) {
  // One key for every attempt of this message: if an attempt reached Resend
  // but its response was lost, the retry is recognised and not sent twice.
  const idempotencyKey = crypto.randomUUID()
  const body = JSON.stringify({ from, to, subject, html, text })
  let lastErr
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let res
    try {
      res = await deps.fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body,
        signal:  AbortSignal.timeout(ATTEMPT_TIMEOUT),
      })
    } catch (e) {
      // Network error or timeout: the message may or may not have arrived;
      // the idempotency key makes the retry safe either way.
      lastErr = new Error(`Resend unreachable: ${e.message}`)
      if (attempt < ATTEMPTS - 1) await deps.sleep(retryDelay(null, attempt))
      continue
    }
    if (res.ok) return true
    const err = await res.json().catch(() => ({}))
    lastErr = new Error(err.message || `Resend error ${res.status}`)
    lastErr.status = res.status
    const transient = res.status === 429 || res.status >= 500
    if (!transient) throw lastErr
    if (attempt < ATTEMPTS - 1) await deps.sleep(retryDelay(res, attempt))
  }
  lastErr.message = `${lastErr.message} (after ${ATTEMPTS} attempts)`
  throw lastErr
}

async function sendEmail({ to, subject, html, text }) {
  const plain = text || htmlToText(html)
  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM || 'FinSurf <noreply@finsurf.app>'
    return sendViaResend({ from, to, subject, html, text: plain })
  }
  const mailer = getMailer()
  if (mailer) {
    const from = process.env.SMTP_FROM || `FinSurf <${process.env.SMTP_USER}>`
    await mailer.sendMail({ from, to, subject, html, text: plain })
    return true
  }
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`)
  return false
}

/** Which provider is configured, and the sender. Config only — never sends. */
function emailConfig() {
  if (process.env.RESEND_API_KEY) return { provider: 'resend', from: process.env.RESEND_FROM || 'FinSurf <noreply@finsurf.app>', fromDefault: !process.env.RESEND_FROM }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
    return { provider: 'smtp', from: process.env.SMTP_FROM || `FinSurf <${process.env.SMTP_USER}>`, fromDefault: !process.env.SMTP_FROM }
  return { provider: 'none' }
}

module.exports = { sendEmail, emailConfig, htmlToText, _deps: deps }
