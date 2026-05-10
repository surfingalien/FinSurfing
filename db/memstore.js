'use strict'
/**
 * Shared in-memory store for demo/no-DB mode.
 * Imported by routes/auth.js, routes/portfolios.js, routes/public.js, routes/admin.js
 * so all modules share the same Maps (singleton due to Node module cache).
 */

const MEM = {
  users:      new Map(), // id → user object
  byEmail:    new Map(), // email → id
  byUsername: new Map(), // username → id
  tokens:     new Map(), // sha256(raw) → { userId, expiresAt }
  otp:        new Map(), // email → { code, expiresAt, attempts }
  resets:     new Map(), // sha256(token) → { userId, expiresAt, used }
  portfolios: new Map(), // id → portfolio object
  holdings:   new Map(), // portfolioId → [ holding, ... ]
  shares:     new Map(), // shareId → share object
}

module.exports = { MEM }
