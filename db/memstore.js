'use strict'
/**
 * Shared in-memory store for demo/no-DB mode.
 * Imported by routes/auth.js, routes/portfolios.js, routes/public.js, routes/admin.js
 * so all modules share the same Maps (singleton due to Node module cache).
 *
 * Disk persistence: durable Maps (users, portfolios, holdings, shares, notes)
 * are snapshotted to data/memstore-snapshot.json on every write so data
 * survives server restarts without needing DATABASE_URL.
 * Transient Maps (tokens, otp, resets) are intentionally not persisted.
 */

const fs   = require('fs')
const path = require('path')

const SNAP_FILE = path.join(__dirname, '../data/memstore-snapshot.json')
const DURABLE   = ['users', 'byEmail', 'byUsername', 'portfolios', 'holdings', 'shares', 'notes']

const MEM = {
  users:      new Map(), // id → user object
  byEmail:    new Map(), // email → id
  byUsername: new Map(), // username → id
  tokens:     new Map(), // sha256(raw) → { userId, expiresAt }  — transient
  otp:        new Map(), // email → { code, expiresAt, attempts } — transient
  resets:     new Map(), // sha256(token) → { userId, expiresAt, used } — transient
  portfolios: new Map(), // id → portfolio object
  holdings:   new Map(), // portfolioId → [ holding, ... ]
  shares:     new Map(), // shareId → share object
  notes:      new Map(), // id → research_note object
}

// Restore durable state from disk snapshot on startup
try {
  if (fs.existsSync(SNAP_FILE)) {
    const snap = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'))
    for (const key of DURABLE) {
      if (snap[key] && typeof snap[key] === 'object') {
        MEM[key] = new Map(Object.entries(snap[key]))
      }
    }
    console.log('[memstore] Restored snapshot from', SNAP_FILE,
      `— ${MEM.portfolios.size} portfolios, ${MEM.holdings.size} holding sets`)
  }
} catch (err) {
  console.error('[memstore] Failed to restore snapshot:', err.message)
}

// Debounced disk write — safe to call after every mutation
let _saveTimer = null
function persistMem() {
  if (_saveTimer) return
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    try {
      const snap = {}
      for (const key of DURABLE) snap[key] = Object.fromEntries(MEM[key])
      fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true })
      const tmp = SNAP_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8')
      fs.renameSync(tmp, SNAP_FILE)
    } catch (err) {
      console.error('[memstore] Failed to persist snapshot:', err.message)
    }
  }, 500)
}

module.exports = { MEM, persistMem }
