'use strict'
/**
 * lib/telegram-notify.js — optional Telegram push notifications.
 *
 * FinSurf surfaces AI analyses and alerts only through the web app + SSE. This
 * pushes the same alert-triggered analyses to Telegram so you get them on your
 * phone. Entirely opt-in: with no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID set,
 * every call is a silent no-op. Formatters are pure (unit-tested); send never
 * throws into the caller — a Telegram outage must not break an alert.
 *
 * Adapted from LobeHub's chat-adapter gateway pattern ("agents where you
 * already chat"). No new dependencies — uses global fetch (Node 18+).
 */

const API = 'https://api.telegram.org'

function token() { return (process.env.TELEGRAM_BOT_TOKEN || '').trim() }
function chatId() { return (process.env.TELEGRAM_CHAT_ID || '').trim() }

function alertsConfigured() {
  return Boolean(token() && chatId() && process.env.TELEGRAM_ALERTS_ENABLED !== 'false')
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Pure formatters (HTML parse mode) ─────────────────────────────────────────

// Turns an alert-broadcaster `analysis` event into a compact message.
function formatAnalysis(ev = {}) {
  const sig = String(ev.signal || 'HOLD').toUpperCase()
  const emoji = sig.includes('BUY') ? '🟢' : sig.includes('SELL') ? '🔴' : '🟡'
  const conf = ev.confidence != null ? ` · conf ${Math.round(ev.confidence * 100)}%` : ''
  const lines = [`${emoji} <b>${escapeHtml(ev.symbol || '?')} ${escapeHtml(sig)}</b>${conf}`]
  if (ev.entry != null)    lines.push(`Entry ${escapeHtml(ev.entry)}`)
  if (ev.stopLoss != null) lines.push(`Stop ${escapeHtml(ev.stopLoss)}`)
  if (ev.trend)            lines.push(`Trend: ${escapeHtml(ev.trend)}`)
  const trig = ev.triggeredBy
  if (trig && trig.type) {
    lines.push(`<i>triggered by ${escapeHtml(trig.type)}${trig.threshold != null ? ` @ ${escapeHtml(trig.threshold)}` : ''}</i>`)
  }
  if (ev.reasoning) lines.push(escapeHtml(String(ev.reasoning).slice(0, 300)))
  return lines.join('\n')
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function send(text, { to } = {}) {
  if (!token()) return false
  const target = to || chatId()
  if (!target) return false
  try {
    const r = await fetch(`${API}/bot${token()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (r.ok) return true
    // 403 = blocked / not a member; 400 = malformed. Log once, don't retry.
    console.warn(`[telegram] send failed HTTP ${r.status}`)
    return false
  } catch (e) {
    console.warn('[telegram] send error:', e.message)
    return false
  }
}

// Fire-and-forget alert used by the broadcaster hook. No-op when unconfigured.
function notifyAnalysis(ev) {
  if (!alertsConfigured()) return
  if (!ev || ev.type !== 'analysis') return
  // Not awaited on purpose — never block the SSE broadcast path.
  send(formatAnalysis(ev)).catch(() => {})
}

module.exports = { alertsConfigured, escapeHtml, formatAnalysis, send, notifyAnalysis }
