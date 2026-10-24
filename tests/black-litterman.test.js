'use strict'

const bl = require('../lib/black-litterman')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5 } }
/** Three names: A and B move together, C is independent. */
function aligned(T = 120) {
  const r = rng(5)
  const returns = Array.from({ length: T }, () => { const m = r() * 0.02; return [m + r() * 0.004, m + r() * 0.004, r() * 0.02] })
  return { symbols: ['A', 'B', 'C'], returns }
}

test('the inverse is an inverse', () => {
  const m = [[4, 1, 0], [1, 3, 1], [0, 1, 2]]
  const inv = bl.invert(m)
  const id = m.map(r => inv[0].map((_, j) => r.reduce((s, x, k) => s + x * inv[k][j], 0)))
  id.forEach((r, i) => r.forEach((x, j) => expect(x).toBeCloseTo(i === j ? 1 : 0, 6)))
})

test('an uncalibrated model barely moves the neutral prior; a well-measured one tilts toward its strongest view', () => {
  const views = { A: 0.06, B: 0.0, C: 0.0 }
  const cold = bl.blackLitterman(aligned(), views, { calibratedN: 0 })
  const warm = bl.blackLitterman(aligned(), views, { calibratedN: 400 })
  expect(cold.confidence).toBe(0.05)
  expect(warm.confidence).toBe(0.8)
  expect(warm.weights.A).toBeGreaterThan(cold.weights.A)
  expect(warm.posterior.A).toBeGreaterThan(cold.posterior.A)
  const sum = o => Object.values(o).reduce((s, x) => s + x, 0)
  expect(sum(warm.weights)).toBeCloseTo(1, 6)
  expect(Object.values(warm.weights).every(w => w >= 0)).toBe(true)          // long-only
})

test('too little history or a single name gives no weights rather than a guess', () => {
  expect(bl.blackLitterman({ symbols: ['A'], returns: [[0.01]] }, {})).toBeNull()
  expect(bl.blackLitterman(aligned(10), { A: 0.01 })).toBeNull()
})
