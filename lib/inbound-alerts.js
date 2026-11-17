'use strict'
/**
 * lib/inbound-alerts.js — alerts sent IN by the user's own TradingView.
 *
 * TradingView can POST to a web address when one of the user's alerts fires.
 * This is the receiving end: each user gets a private address, and whatever
 * arrives is recorded and shown on the Research Desk queue, the symbol's chart
 * and the Alerts page.
 *
 * What it deliberately is not:
 *  - It never places an order and nothing downstream trades on an alert. An
 *    `action: "buy"` in the message is stored as text and nothing else.
 *  - The message never reaches a model. It is text somebody else can shape
 *    (anyone holding the address can post to it), so it is stored capped,
 *    stripped of control characters, and only ever rendered as text.
 *
 * Security: the address carries a 256-bit random key. TradingView cannot send
 * a header, so the key rides in the path; only its SHA-256 is stored, the key
 * itself is shown once at creation, and rotating it invalidates the old
 * address at once. An unknown key gets a plain 404 with no detail.
 *
 * Store: data/inbound-alerts.json (atomic writes; registered in
 * lib/durable-files.js so it survives a deploy). Tests: tests/inbound-alerts.test.js
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { DATA_DIR } = require('./data-dir')
const { writeJsonAtomic } = require('./atomic-write')

const STORE_FILE   = path.join(DATA_DIR, 'inbound-alerts.json')
const MAX_PER_USER = 300          // newest kept per user
const MAX_MESSAGE  = 300
const MAX_BODY     = 4096         // bytes of a webhook body we will read
const RECENT_DAYS  = 3            // how long an alert counts as "needs a look"
const SYMBOL       = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/

const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex')
const newKey  = () => crypto.randomBytes(32).toString('base64url')
const clean   = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

/** "NASDAQ:AAPL" → "AAPL"; "btcusd" → "BTCUSD"; anything that is not a ticker → null. */
function normSymbol(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toUpperCase().split(':').pop().replace(/[^A-Z0-9.\-]/g, '')
  return SYMBOL.test(s) ? s : null
}

/**
 * A webhook body → { symbol, message, price, action } or { error }.
 * TradingView sends JSON when the alert message is valid JSON, plain text
 * otherwise. Both are accepted:
 *   {"ticker":"{{ticker}}","price":{{close}},"message":"broke out"}
 *   AAPL broke above the 200-day
 * Pure.
 */
function parseAlert(body) {
  let obj = null
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) obj = body
  else {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
    if (!text.trim()) return { error: 'empty alert' }
    if (text.trim().startsWith('{')) { try { obj = JSON.parse(text) } catch { obj = null } }
    if (!obj) {
      const first = text.trim().split(/\s+/)[0]
      const symbol = normSymbol(first.replace(/[,;]+$/, ''))
      // A bare word is only a ticker when it is written like one (capitals), so "price crossed…" is not "PRICE".
      const looksLikeTicker = symbol && /^[A-Z0-9:.\-]+[,;]?$/.test(first)
      return { symbol: looksLikeTicker ? symbol : null, message: clean(text, MAX_MESSAGE), price: null, action: null }
    }
  }
  if (Array.isArray(obj)) return { error: 'an alert must be one object or a line of text' }
  const symbol = normSymbol(obj.ticker ?? obj.symbol ?? obj.tickerid ?? '')
  const price = Number(obj.price ?? obj.close)
  const message = clean(obj.message ?? obj.text ?? obj.alert ?? obj.name ?? '', MAX_MESSAGE)
  const action = clean(obj.action ?? obj.side ?? '', 20) || null
  if (!symbol && !message) return { error: 'the alert has neither a ticker nor a message' }
  return { symbol, message, price: Number.isFinite(price) && price > 0 ? price : null, action }
}

// ── Store ────────────────────────────────────────────────────────────────────

function read(file = STORE_FILE) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { keys: s.keys && typeof s.keys === 'object' ? s.keys : {}, alerts: Array.isArray(s.alerts) ? s.alerts : [] }
  } catch { return { keys: {}, alerts: [] } }
}
const write = (s, file = STORE_FILE) => writeJsonAtomic(file, s)

/** Create or rotate the user's key. Returns the key ONCE; only its hash is kept. */
function rotateKey(userId, { file = STORE_FILE, now = Date.now() } = {}) {
  const s = read(file), key = newKey()
  s.keys[String(userId)] = { hash: hashKey(key), createdAt: new Date(now).toISOString() }
  write(s, file)
  return { key, createdAt: s.keys[String(userId)].createdAt }
}

function revokeKey(userId, { file = STORE_FILE } = {}) {
  const s = read(file)
  if (!s.keys[String(userId)]) return false
  delete s.keys[String(userId)]
  write(s, file)
  return true
}

/** Whether the user has an address, and what has arrived — never the key. */
function keyStatus(userId, { file = STORE_FILE } = {}) {
  const s = read(file), k = s.keys[String(userId)]
  const mine = s.alerts.filter(a => a.userId === String(userId))
  return { exists: !!k, createdAt: k?.createdAt ?? null, received: mine.length, lastAt: mine.length ? mine[mine.length - 1].at : null }
}

/** The owner of a key, or null. */
function userForKey(key, { file = STORE_FILE } = {}) {
  if (typeof key !== 'string' || key.length < 20 || key.length > 100) return null
  const h = hashKey(key), s = read(file)
  for (const [userId, k] of Object.entries(s.keys)) {
    if (k.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(h))) return userId
  }
  return null
}

/** Record one parsed alert for a user. Keeps the newest MAX_PER_USER per user. */
function record(userId, alert, { file = STORE_FILE, now = Date.now() } = {}) {
  const s = read(file), uid = String(userId)
  const row = {
    id: crypto.randomBytes(6).toString('hex'), userId: uid, at: new Date(now).toISOString(),
    symbol: alert.symbol ?? null, message: alert.message || '', price: alert.price ?? null, action: alert.action ?? null,
  }
  s.alerts.push(row)
  const mine = s.alerts.filter(a => a.userId === uid)
  if (mine.length > MAX_PER_USER) {
    const drop = new Set(mine.slice(0, mine.length - MAX_PER_USER).map(a => a.id))
    s.alerts = s.alerts.filter(a => !drop.has(a.id))
  }
  write(s, file)
  return row
}

/** The user's alerts, newest first. */
function list(userId, { file = STORE_FILE, limit = 100, symbol = null } = {}) {
  const uid = String(userId)
  return read(file).alerts
    .filter(a => a.userId === uid && (!symbol || a.symbol === symbol))
    .reverse().slice(0, limit)
    .map(({ userId: _u, ...a }) => a)
}

function remove(userId, id, { file = STORE_FILE } = {}) {
  const s = read(file), before = s.alerts.length
  s.alerts = s.alerts.filter(a => !(a.userId === String(userId) && a.id === id))
  if (s.alerts.length === before) return false
  write(s, file)
  return true
}

/**
 * Per symbol, the alerts of the last RECENT_DAYS: { SYM: {count, lastAt, message} }.
 * What the Research Desk queue reads. Pure over the rows it is given.
 */
function recentBySymbol(rows = [], { now = Date.now(), days = RECENT_DAYS } = {}) {
  const since = now - days * 86400000, out = {}
  for (const a of rows) {
    if (!a.symbol || new Date(a.at).getTime() < since) continue
    const cur = out[a.symbol]
    if (!cur) out[a.symbol] = { count: 1, lastAt: a.at, message: a.message || '' }
    else { cur.count += 1; if (a.at > cur.lastAt) { cur.lastAt = a.at; cur.message = a.message || '' } }
  }
  return out
}

module.exports = {
  STORE_FILE, MAX_PER_USER, MAX_MESSAGE, MAX_BODY, RECENT_DAYS,
  normSymbol, parseAlert, hashKey,
  rotateKey, revokeKey, keyStatus, userForKey, record, list, remove, recentBySymbol,
}
