'use strict'
/**
 * lib/telegram-bot.js — optional Telegram command bot.
 *
 * Long-polls getUpdates and answers a few read-only status queries, restricted
 * to the single configured chat id. Opt-in: start() is a no-op unless both
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. Uses global fetch (Node 18+),
 * no new dependencies.
 *
 * Commands: /help, /status, /learnings
 */

const notify = require('./telegram-notify')

const API = 'https://api.telegram.org'
let _running = false
let _offset

function token() { return (process.env.TELEGRAM_BOT_TOKEN || '').trim() }
function chatId() { return (process.env.TELEGRAM_CHAT_ID || '').trim() }

const HELP = [
  '<b>FinSurf bot</b>',
  '/status — server + AI Brain memory status',
  '/learnings — current self-learned findings',
  '/help — this message',
].join('\n')

// Pure: extract (command, args) or null. Handles the '/cmd@Bot' group form.
function parseCommand(text) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const parts = t.split(/\s+/)
  let cmd = parts[0].slice(1)
  if (cmd.includes('@')) cmd = cmd.split('@', 1)[0]
  return { cmd: cmd.toLowerCase(), args: parts.slice(1) }
}

function handleStatus() {
  let predCount = 0, learnAge = null
  try {
    const bl = require('./brain-learnings')
    predCount = bl.readPredictions().length
    const l = bl.readLearnings()
    if (l && l.updatedAt) learnAge = Math.floor((Date.now() - new Date(l.updatedAt).getTime()) / 86400000)
  } catch {}
  return [
    '<b>Status</b>',
    'FinSurf: online',
    `Logged predictions: ${predCount}`,
    learnAge == null ? 'AI learnings: none yet' : `AI learnings: updated ${learnAge}d ago`,
  ].join('\n')
}

function handleLearnings() {
  try {
    const bl = require('./brain-learnings')
    const data = bl.readLearnings()
    if (!data || !data.keyLearnings || !data.keyLearnings.length) return 'No AI learnings yet — need more resolved predictions.'
    const effective = bl.applyOverrides(data.keyLearnings, bl.readOverrides())
    const lines = ['<b>Self-learned findings</b>']
    effective.slice(0, 8).forEach((l, i) => lines.push(`${i + 1}. ${notify.escapeHtml(l)}`))
    return lines.join('\n')
  } catch { return 'Learnings unavailable.' }
}

async function dispatch(cmd) {
  if (cmd === 'start' || cmd === 'help') return HELP
  if (cmd === 'status') return handleStatus()
  if (cmd === 'learnings') return handleLearnings()
  return `Unknown command /${cmd}. Try /help.`
}

async function processUpdate(update) {
  const message = update.message || update.edited_message
  if (!message) return
  const fromChat = String(message.chat && message.chat.id)
  const parsed = parseCommand(message.text)
  if (!parsed) return
  if (fromChat !== chatId()) {
    await notify.send('Not authorized.', { to: fromChat })
    return
  }
  let reply
  try { reply = await dispatch(parsed.cmd) }
  catch (e) { reply = `Command /${parsed.cmd} failed.` }
  await notify.send(reply, { to: fromChat })
}

async function loop() {
  const timeout = 30
  while (_running) {
    try {
      const params = new URLSearchParams({ timeout: String(timeout) })
      if (_offset != null) params.set('offset', String(_offset))
      const r = await fetch(`${API}/bot${token()}/getUpdates?${params}`, {
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      })
      if (!r.ok) { await sleep(5000); continue }
      const body = await r.json()
      for (const update of body.result || []) {
        _offset = update.update_id + 1
        await processUpdate(update)
      }
    } catch (e) {
      // Timeouts are normal on a quiet long-poll; back off briefly on real errors.
      await sleep(3000)
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function start() {
  if (_running) return
  if (!(token() && chatId())) {
    console.log('[telegram-bot] disabled (token/chat id unset)')
    return
  }
  _running = true
  console.log('[telegram-bot] command bot started')
  loop().catch(e => console.error('[telegram-bot] loop crashed:', e.message))
}

function stop() { _running = false }

module.exports = { start, stop, parseCommand, dispatch, handleStatus, handleLearnings, HELP }
