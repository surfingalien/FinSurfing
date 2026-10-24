'use strict'
// Protections pause NEW buys after damage; exits are never blocked.

const pb = require('../lib/paper-broker')

const NOW = new Date('2026-10-20T15:00:00Z')
const ago = d => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const sell = (symbol, daysAgo, realized, exitKind = 'stop') => ({ at: ago(daysAgo), symbol, side: 'sell', status: 'filled', realized, exitKind })
const book = () => ({ ...pb.emptyPortfolio(10_000), positions: { HELD: { shares: 10, avgCost: 100, bracket: { stop: 90, t2: 120, t1Done: true } } } })
const buy = (trades, symbol = 'NEW') => pb.evaluateOrder({ portfolio: book(), trades, symbol, side: 'buy', price: 100, now: NOW, bracket: { stop: 94, t1: 106, t2: 112 } })

test('three stop-outs in a week pause every buy for two days; selling still works', () => {
  const trades = [sell('A', 3, -60), sell('B', 2, -50), sell('C', 1, -40)]
  const r = buy(trades)
  expect(r).toMatchObject({ ok: false, protection: { kind: 'stoploss-guard' } })
  expect(r.reason).toMatch(/buys paused \(stoploss-guard\): 3 stop-outs in 7 days/)
  expect(pb.evaluateOrder({ portfolio: book(), trades, symbol: 'HELD', side: 'sell', price: 95, now: NOW, exit: true }).ok).toBe(true)
  // two days after the last stop the pause has lapsed (the cooldown on C, A, B is per symbol only)
  expect(pb.protections(trades, book(), new Date(NOW.getTime() + 1.1 * 86_400_000)).global).toBeNull()
})

test('a realized drawdown past the limit pauses buys', () => {
  const trades = [sell('A', 20, 500, 'target'), sell('B', 2, -600, 'time'), sell('C', 1, -400, 'time')]
  const p = pb.protections(trades, book(), NOW)
  expect(p.global).toMatchObject({ kind: 'max-drawdown' })
  expect(p.global.reason).toMatch(/realized drawdown 9\.5% in 30 days \(limit 8%\)/)
})

test('a symbol just exited cools down; one that keeps losing is blocked for a week', () => {
  const cool = buy([sell('NEW', 1, 30, 'target')])
  expect(cool).toMatchObject({ ok: false, protection: { kind: 'cooldown' } })
  expect(buy([sell('NEW', 3, 30, 'target')]).ok).toBe(true)
  const loser = pb.protections([sell('NEW', 6, -20, 'time'), sell('NEW', 4, -15, 'time')], book(), NOW)
  expect(loser.symbols.NEW).toMatchObject({ kind: 'low-profit' })
  expect(loser.symbols.NEW.reason).toMatch(/lost \$35\.00 over its last 2 closed trades/)
})

test('env may tighten a protection, never loosen it', () => {
  process.env.PAPER_STOPLOSS_LIMIT = '10'
  process.env.PAPER_COOLDOWN_DAYS = '5'
  expect(pb.protectionLimits()).toMatchObject({ stoplossLimit: 3, cooldownDays: 5 })
  process.env.PAPER_STOPLOSS_LIMIT = '2'
  process.env.PAPER_COOLDOWN_DAYS = '1'
  expect(pb.protectionLimits()).toMatchObject({ stoplossLimit: 2, cooldownDays: 2 })
  delete process.env.PAPER_STOPLOSS_LIMIT
  delete process.env.PAPER_COOLDOWN_DAYS
})
