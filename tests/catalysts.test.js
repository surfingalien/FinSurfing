'use strict'
const CAT = require('../lib/catalysts')

describe('catalyst calendar', () => {
  test('third Fridays, quarterly quad witching and the S&P rebalance', () => {
    expect(CAT.thirdFriday(2026, 11)).toBe('2026-12-18')
    expect(CAT.thirdFriday(2027, 0)).toBe('2027-01-15')
    const m = CAT.marketCalendar('2026-11-09', 60)
    expect(m.map(e => `${e.date} ${e.kind}`)).toEqual([
      '2026-11-20 options-expiry', '2026-12-18 options-expiry', '2026-12-18 index-rebalance',
    ])
    expect(m[1].label).toMatch(/quad witching/)
  })

  test('a calendar earnings date is scheduled; without one it is estimated from the last filing and says so', () => {
    const today = '2026-11-09'
    const sched = CAT.buildCatalysts({ today, earnings: { nextEarningsDate: '2026-12-02', epsEstimate: '1.20', source: 'finnhub' } })
    const e = sched.find(x => x.kind === 'earnings')
    expect(e).toMatchObject({ date: '2026-12-02', scheduled: true, daysAway: 23 })
    expect(e.label).toMatch(/EPS estimate 1.20/)
    const est = CAT.buildCatalysts({ today, lastFiled: '2026-10-30' }).find(x => x.kind === 'earnings')
    expect(est).toMatchObject({ date: '2027-01-29', scheduled: false })
    expect(CAT.buildCatalysts({ today }).some(x => x.kind === 'earnings')).toBe(false)
    expect(CAT.buildCatalysts({ today, lastFiled: '2015-02-24' }).some(x => x.kind === 'earnings')).toBe(false)   // stale filing: no projection
  })

  test('ex-dividend: a declared date wins; otherwise the cycle is projected and an overdue one is called out', () => {
    expect(CAT.nextExDividend([{ date: '2026-08-10' }, { date: '2026-11-20', dividend: 0.25 }], '2026-11-09')).toMatchObject({ date: '2026-11-20', scheduled: true, amount: 0.25 })
    const quarterly = ['2025-11-10', '2026-02-09', '2026-05-11', '2026-08-10'].map(date => ({ date }))
    const est = CAT.nextExDividend(quarterly, '2026-11-09')
    expect(est.scheduled).toBe(false)
    expect(est.date >= '2026-11-09').toBe(true)
    const stale = CAT.nextExDividend(['2025-05-12', '2025-08-11', '2025-11-10'].map(date => ({ date })), '2026-11-09')
    expect(stale.overdue).toBe(true)
    expect(CAT.nextExDividend([{ date: '2026-08-10' }], '2026-11-09')).toBeNull()
  })

  test('lock-up expiry only while still ahead; events come nearest first', () => {
    const ev = CAT.buildCatalysts({ today: '2026-11-09', ipoDate: '2026-06-15', earnings: { nextEarningsDate: '2027-02-01' } })
    expect(ev.find(e => e.kind === 'lockup').date).toBe('2026-12-12')
    expect(CAT.buildCatalysts({ today: '2026-11-09', ipoDate: '2025-01-15' }).some(e => e.kind === 'lockup')).toBe(false)
    const dates = ev.map(e => e.date)
    expect([...dates].sort()).toEqual(dates)
  })

  test('the measured record around earnings is stated with intervals, and the evidence line lists own events first', () => {
    const stats = { earningsWindowImpact: {
      imminent: { n: 30, nBench: 30, alphaWinRate: 0.4, alphaWinRateLo: 0.25, alphaWinRateHi: 0.58, horizon: 30 },
      distant: { n: 200, nBench: 190, alphaWinRate: 0.55, alphaWinRateLo: 0.48, alphaWinRateHi: 0.62, horizon: 30 },
    } }
    const rec = CAT.earningsRecord(stats)
    expect(rec).toMatch(/≤7 days before earnings beat the benchmark 40% \(95% CI 25%–58%, n=30\)/)
    expect(CAT.earningsRecord({})).toBeNull()
    const ev = CAT.buildCatalysts({ today: '2026-11-09', earnings: { nextEarningsDate: '2026-12-02' } })
    const text = CAT.describe(ev, 'AAA', rec)
    expect(text).toMatch(/^Upcoming catalysts for AAA: 2026-12-02 \(23d\): Earnings report/)
    expect(text).toMatch(/S&P 500 quarterly rebalance/)
    expect(text).not.toMatch(/Monthly options expiry/)
  })
})
