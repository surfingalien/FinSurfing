/**
 * src/utils/formatPct.js
 *
 * Signed percentage rendering.
 *
 * Cards used to hard-code the sign — `+{stock.targetReturn}%` — which renders a
 * negative target as the nonsense string "+−15%". The server-side price
 * coherence gate (lib/price-coherence.js) now drops such picks at the source,
 * but scans persisted before it existed are still replayed by
 * GET /api/ai-brain/scan/latest, so the display keeps its own guard.
 */

/** A signed percentage that takes its sign from the value, not the caller. */
export function signedPct(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${digits > 0 ? n.toFixed(digits) : n}%`
}

/**
 * A magnitude rendered as a drawdown. Stop-loss is stated as a positive
 * percentage the price may fall, so the minus sign is presentation — but a
 * value that already arrives negative must not become "--12%".
 */
export function drawdownPct(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const m = Math.abs(n)
  return `-${digits > 0 ? m.toFixed(digits) : m}%`
}
