'use strict'
const PB = require('../lib/paper-broker')

describe('implementation shortfall on paper fills', () => {
  test('signed as a cost: paying above the decision on a buy, receiving below it on a sell', () => {
    expect(PB.shortfallOf({ side: 'buy', fill: 101, quote: 100.9, decision: 100 })).toEqual({ decisionPrice: 100, shortfallBps: 100, delayBps: 90 })
    expect(PB.shortfallOf({ side: 'sell', fill: 93, quote: 93.05, decision: 95 }).shortfallBps).toBeCloseTo(210.5, 1)   // a stop gapped through
    expect(PB.shortfallOf({ side: 'sell', fill: 112, decision: 110 }).shortfallBps).toBeCloseTo(-181.8, 1)              // a target filled better
    expect(PB.shortfallOf({ side: 'buy', fill: 100, decision: null })).toEqual({})
  })

  test('summary by kind, in bps and dollars; trades without a decision price are left out', () => {
    const trades = [
      { status: 'filled', side: 'buy', shares: 10, ...PB.shortfallOf({ side: 'buy', fill: 101, quote: 100.5, decision: 100 }) },
      { status: 'filled', side: 'buy', shares: 10, ...PB.shortfallOf({ side: 'buy', fill: 100.2, quote: 100.1, decision: 100 }) },
      { status: 'filled', side: 'sell', exitKind: 'stop', shares: 10, ...PB.shortfallOf({ side: 'sell', fill: 93, quote: 93, decision: 95 }) },
      { status: 'filled', side: 'sell', exitKind: 'time', shares: 10 },
      { status: 'rejected', side: 'buy', shortfallBps: 999 },
    ]
    const s = PB.shortfallSummary(trades)
    expect(s.n).toBe(3)
    expect(s.byKind.entry).toMatchObject({ n: 2, meanBps: 60, delay: 30 })
    expect(s.byKind.stop.n).toBe(1)
    expect(s.costUsd).toBeCloseTo(10 + 2 + 20, 1)
    expect(PB.shortfallSummary([])).toBeNull()
  })

  test('bracket exits carry the level they were decided at', () => {
    const portfolio = { positions: { AAA: { shares: 10, avgCost: 100, openedAt: new Date().toISOString(), bracket: { stop: 95, t1: 105, t2: 110 } } } }
    expect(PB.bracketExits(portfolio, { AAA: 93 }).exits[0]).toMatchObject({ kind: 'stop', level: 95, price: 93 })
    expect(PB.bracketExits(portfolio, { AAA: 111 }).exits[0]).toMatchObject({ kind: 'target', level: 110 })
  })
})
