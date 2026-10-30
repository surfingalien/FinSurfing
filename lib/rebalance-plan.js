'use strict'

/**
 * lib/rebalance-plan.js — the rebalancing arithmetic, done in code.
 *
 * The AI Rebalancer used to hand the model holdings and target weights and ask
 * it for share counts, dollar amounts and the post-trade weights. That is
 * arithmetic, and a model doing arithmetic in prose gets it wrong without
 * anyone noticing. Here code computes the trades; the model only explains and
 * prioritises them (routes/rebalancer.js tells it the numbers are fixed).
 *
 * Method: each sector's dollar gap (target weight × portfolio value − current
 * value) is split across the sector's holdings in proportion to their value,
 * and rounded to whole shares toward zero (never sell more than is held, never
 * spend money a sale did not raise). A sector with a target but no holding has
 * nothing to buy and is reported, not invented.
 *
 * Pure. Tests: tests/rebalance-plan.test.js
 */

const round = (v, d = 2) => +Number(v).toFixed(d)

/**
 * @param {object} o
 * @param {{symbol:string, shares:number, price:number, sector?:string}[]} o.holdings
 * @param {Object<string, number>} o.targetAllocation  sector → target percent
 */
function planRebalance({ holdings, targetAllocation = {} }) {
  const rows = (holdings || [])
    .map(h => ({ symbol: String(h.symbol).toUpperCase(), shares: Number(h.shares), price: Number(h.price), sector: h.sector || 'Unknown' }))
    .filter(h => h.shares > 0 && h.price > 0)
  const total = rows.reduce((s, h) => s + h.shares * h.price, 0)
  const notes = []
  if (!(total > 0)) return { total: 0, trades: [], sectors: [], cashResidual: 0, notes: ['No priced holdings to rebalance.'] }

  const curBySector = {}
  for (const h of rows) curBySector[h.sector] = (curBySector[h.sector] || 0) + h.shares * h.price

  // A sector with no stated target keeps its current weight.
  const sectorNames = [...new Set([...Object.keys(curBySector), ...Object.keys(targetAllocation)])]
  const target = {}
  for (const s of sectorNames) {
    const t = Number(targetAllocation[s])
    target[s] = Number.isFinite(t) && t >= 0 ? t : ((curBySector[s] || 0) / total) * 100
  }
  const sumT = Object.values(target).reduce((a, b) => a + b, 0)
  if (!(sumT > 0)) return { total: round(total), trades: [], sectors: [], cashResidual: 0, notes: ['Target weights add up to 0%.'] }
  if (Math.abs(sumT - 100) > 0.5) {
    notes.push(`Targets add up to ${round(sumT, 1)}%, so they were scaled to 100%.`)
    for (const s of sectorNames) target[s] = (target[s] / sumT) * 100
  }

  const trades = []
  for (const s of sectorNames) {
    const cur = curBySector[s] || 0
    const gap = (target[s] / 100) * total - cur
    const members = rows.filter(h => h.sector === s)
    if (!members.length) {
      if (target[s] > 0.5) notes.push(`${s} has a ${round(target[s], 1)}% target but no holding to add to — choose one to buy.`)
      continue
    }
    for (const h of members) {
      const value = h.shares * h.price
      const want = gap * (value / cur)
      // Whole shares for whole-share holdings; fractional (4 dp) otherwise.
      const whole = Number.isInteger(h.shares)
      // (a tiny nudge so 21.9999999 from float error is still 22)
      const raw = want / h.price + Math.sign(want) * 1e-9
      let shares = whole ? Math.trunc(raw) : Math.trunc(raw * 1e4) / 1e4
      if (shares < 0) shares = Math.max(shares, -h.shares)
      if (shares === 0) continue
      trades.push({ symbol: h.symbol, sector: s, side: shares > 0 ? 'buy' : 'sell', shares: Math.abs(shares), whole, price: h.price, value: round(Math.abs(shares) * h.price) })
    }
  }

  // Sales fund the buys. If rounding left buys costing more than the sales
  // raise, scale the buys down to fit (rounded down again).
  const raised = trades.filter(t => t.side === 'sell').reduce((s, t) => s + t.value, 0)
  const spent  = trades.filter(t => t.side === 'buy').reduce((s, t) => s + t.value, 0)
  if (spent > raised + 0.005) {
    const k = raised / spent
    for (const t of trades.filter(t => t.side === 'buy')) {
      t.shares = t.whole ? Math.floor(t.shares * k) : Math.floor(t.shares * k * 1e4) / 1e4
      t.value = round(t.shares * t.price)
    }
  }
  const kept = trades.filter(t => t.shares > 0).map(({ whole, ...t }) => t)
  const cashResidual = round(raised - kept.filter(t => t.side === 'buy').reduce((s, t) => s + t.value, 0))

  const after = {}
  for (const h of rows) {
    const t = kept.find(x => x.symbol === h.symbol)
    const sh = h.shares + (t ? (t.side === 'buy' ? t.shares : -t.shares) : 0)
    after[h.sector] = (after[h.sector] || 0) + sh * h.price
  }
  const sectors = sectorNames.map(s => ({
    sector: s,
    currentPct: round(((curBySector[s] || 0) / total) * 100, 1),
    targetPct:  round(target[s], 1),
    afterPct:   round(((after[s] || 0) / total) * 100, 1),
  })).sort((a, b) => Math.abs(b.targetPct - b.currentPct) - Math.abs(a.targetPct - a.currentPct))

  return { total: round(total), trades: kept.sort((a, b) => b.value - a.value), sectors, cashResidual, notes }
}

module.exports = { planRebalance }
