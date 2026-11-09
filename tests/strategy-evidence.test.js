'use strict'
const SE = require('../lib/strategy-evidence')
const SL = require('../lib/strategy-lab')
const { rng } = require('../lib/quant/linalg')

const T0 = Date.UTC(2020, 0, 1) / 1000
const day = i => new Date((T0 + i * 86400) * 1000).toISOString().slice(0, 10)
/** A trade list of `pnls` round trips, each bought on bar `at(i)`. */
const tradesOf = (pnls, at = i => 300 + i * 10) => pnls.flatMap((p, i) => [
  { type: 'buy', date: day(at(i)), shares: 10 },
  { type: 'sell', date: day(at(i) + 5), shares: 10, pnl: p },
])

describe('trade evidence', () => {
  test('a bracket position closed in two lots is ONE trade, share-weighted', () => {
    const pos = SE.positionsOf([
      { type: 'buy', date: '2024-01-02', shares: 10 },
      { type: 'sell', date: '2024-01-05', shares: 5, pnl: 10 },
      { type: 'sell', date: '2024-01-09', shares: 5, pnl: -2 },
      { type: 'buy', date: '2024-02-01', shares: 4 },
      { type: 'sell', date: '2024-02-03', shares: 4, pnl: 3, open: true },   // end-of-test liquidation: not a decided trade
    ])
    expect(pos).toEqual([{ entryDate: '2024-01-02', pnl: 4 }])
  })

  test('two lucky trades are not evidence; many trades with a real edge are', () => {
    expect(SE.tradeEvidence(tradesOf([8, 6])).enough).toBe(false)
    const g = rng(3)
    const good = SE.tradeEvidence(tradesOf(Array.from({ length: 40 }, () => 1 + 2 * g.normal())))
    expect(good.trades).toBe(40)
    expect(good.t).toBeGreaterThan(SE.TRADE_T_MIN)
    expect(good.enough).toBe(true)
    const g2 = rng(4)
    const coinFlip = SE.tradeEvidence(tradesOf(Array.from({ length: 40 }, () => 3 * g2.normal() - 0.5)))
    expect(coinFlip.enough).toBe(false)
  })

  test('evidenceProblem names the reason, and never blocks when nothing was measured', () => {
    expect(SE.evidenceProblem({ evidence: SE.tradeEvidence(tradesOf([5, 5])) })).toMatch(/too few trades/)
    expect(SE.evidenceProblem({ evidence: { trades: 30, t: 0.2, enough: false } })).toMatch(/no measurable edge/)
    expect(SE.evidenceProblem({})).toBeNull()
  })
})

describe('regime breakdown', () => {
  // Two years of bars: a calm uptrend, then a volatile downtrend.
  function series() {
    const g = rng(9), closes = []; let p = 100
    for (let i = 0; i < 700; i++) { const down = i >= 420; p *= 1 + (down ? -0.0015 : 0.001) + (down ? 0.025 : 0.006) * g.normal(); closes.push(p) }
    return { timestamps: closes.map((_, i) => T0 + i * 86400), closes }
  }

  test('trades are labelled by the market at their signal bar; a common state where it loses significantly fails', () => {
    const s = series()
    // Wins in the first regime (bars 300–410), loses steadily in the second (430–690).
    const wins = Array.from({ length: 12 }, (_, i) => 300 + i * 9), losses = Array.from({ length: 25 }, (_, i) => 440 + i * 10)
    const pnls = [...wins.map(() => 2), ...losses.map((_, i) => -1.5 - (i % 3) * 0.5)]
    const trades = tradesOf(pnls, i => [...wins, ...losses][i])
    const r = SE.regimeBreakdown(trades, s.timestamps, s.closes)
    expect(r.states.length).toBeGreaterThanOrEqual(2)
    expect(r.failing.length).toBeGreaterThan(0)
    expect(r.states.find(x => r.failing.includes(x.label)).meanPct).toBeLessThan(0)
    expect(SE.evidenceProblem({ evidence: { enough: true }, regimes: r })).toMatch(/loses significantly/)
  })

  test('a state too rare or too thin to judge never fails', () => {
    const s = series()
    const trades = tradesOf([-3, -4, -2], i => 450 + i * 10)   // 3 losing trades: below MIN_STATE_TRADES
    expect(SE.regimeBreakdown(trades, s.timestamps, s.closes).failing).toEqual([])
  })
})

describe('report card and the admission gate', () => {
  const item = {
    verdict: 'validated', early: { alpha: 3, sharpeRatio: 0.6 }, recent: { alpha: 1, sharpeRatio: 0.4 },
    metrics: { alpha: 4, costBps: 10 }, robustness: { plateau: true, passed: 5, tested: 8 },
    evidence: { trades: 42, meanPct: 0.8, t: 2.1, profitFactor: 1.6, enough: true },
    regimes: { states: [{ label: 'up-calm', trades: 20, meanPct: 1 }, { label: 'range-calm', trades: 12, meanPct: 0.4 }], failing: [] },
    deflated: { pass: true, dsr: 0.8, nTrials: 6 }, pbo: { overfit: false, pbo: 0.2 }, cpcv: { generalises: true, medianSharpe: 0.5, p10Sharpe: 0.1, p90Sharpe: 0.9 },
  }

  test('a strategy that clears everything gets a passing card; walk-forward is "review" until judged forward', () => {
    const card = SE.reportCard(item)
    expect(card.rows.map(r => r.key)).toEqual(['oos', 'walkforward', 'stability', 'costs', 'trades', 'regimes', 'hypothesis', 'deflated', 'pbo', 'cpcv'])
    expect(card.rows.filter(r => r.status === 'fail')).toEqual([])
    expect(card.rows.find(r => r.key === 'walkforward').status).toBe('review')
    expect(SE.reportCard({ ...item, params: { blocks: 6 } }).rows.find(r => r.key === 'walkforward').status).toBe('pass')
    expect(SL.admissionProblem(item)).toBeNull()
  })

  test('each failing gate shows as a failing row, and the gate gives the first reason', () => {
    const thin = { ...item, evidence: { ...item.evidence, trades: 6, enough: false } }
    expect(SE.reportCard(thin).overall).toBe('fail')
    expect(SL.admissionProblem(thin)).toMatch(/too few trades/)
    const overfit = { ...item, pbo: { overfit: true, pbo: 0.8 } }
    expect(SE.reportCard(overfit).rows.find(r => r.key === 'pbo').status).toBe('fail')
    expect(SL.admissionProblem(overfit)).toMatch(/PBO/)
    expect(SL.cardFor(item).rows[0]).not.toHaveProperty('detail')    // stored compactly
  })
})

describe('hypothesis first', () => {
  const st = (label, xs) => ({ label, trades: xs.length, meanPct: xs.reduce((a, v) => a + v, 0) / xs.length, sum: xs.reduce((a, v) => a + v, 0), sumSq: xs.reduce((a, v) => a + v * v, 0) })
  const g = rng(11), noisy = (m, n) => Array.from({ length: n }, () => m + 0.5 * g.normal())

  test('only allow-listed markets are accepted; a missing claim takes the type default, an invented one is dropped', () => {
    expect(SE.parseHypothesis({ worksIn: 'Uptrend', statement: 'momentum  persists\nin trends' })).toEqual({ worksIn: 'uptrend', statement: 'momentum persists in trends', source: 'model' })
    expect(SE.parseHypothesis({ worksIn: 'whenever it rains' }, 'range')).toMatchObject({ worksIn: 'range', source: 'default' })
    expect(SE.parseHypothesis({ worksIn: 'whenever it rains' })).toBeNull()
    expect(SE.parseHypothesis(null)).toBeNull()
  })

  test('the claimed states are pooled exactly: supported, contradicted, unclear or too few', () => {
    const regimes = { states: [st('up-calm', noisy(1, 12)), st('up-stressed', noisy(1, 6)), st('range-calm', noisy(-1, 15))] }
    const up = SE.hypothesisTest({ worksIn: 'uptrend', source: 'model' }, regimes)
    expect(up.inside.trades).toBe(18)
    expect(up.outside.trades).toBe(15)
    expect(up.verdict).toBe('supported')
    expect(SE.hypothesisTest({ worksIn: 'range' }, regimes).verdict).toBe('contradicted')
    expect(SE.hypothesisTest({ worksIn: 'downtrend' }, regimes).verdict).toBe('insufficient')
    const flat = { states: [st('range-calm', noisy(0, 20).map(v => v - 0.0))] }
    expect(['unclear', 'supported', 'contradicted']).toContain(SE.hypothesisTest({ worksIn: 'range' }, flat).verdict)
    expect(SE.hypothesisTest(null, regimes)).toBeNull()
    expect(SE.hypothesisTest({ worksIn: 'uptrend' }, null)).toBeNull()
  })

  test('a contradicted claim blocks admission and fails its card row; an unclear one is only "review"', () => {
    const ok = { evidence: { enough: true }, regimes: { states: [], failing: [] } }
    const contra = { ...ok, hypothesisTest: { worksIn: 'range', inside: { trades: 15, meanPct: -1, t: -3 }, outside: { trades: 0 }, verdict: 'contradicted' } }
    expect(SE.evidenceProblem(contra)).toMatch(/hypothesis is contradicted.*range-bound/)
    expect(SE.reportCard(contra).rows.find(r => r.key === 'hypothesis').status).toBe('fail')
    const unclear = { ...ok, hypothesisTest: { ...contra.hypothesisTest, verdict: 'unclear' } }
    expect(SE.evidenceProblem(unclear)).toBeNull()
    expect(SE.reportCard(unclear).rows.find(r => r.key === 'hypothesis').status).toBe('review')
    expect(SE.storedHypothesis({ hypothesis: { worksIn: 'range', statement: 's', source: 'model' }, hypothesisTest: contra.hypothesisTest })).toMatchObject({ worksIn: 'range', verdict: 'contradicted' })
  })

  test('proposals must state a hypothesis; the parser keeps a valid one and falls back to the type default', () => {
    const prompt = SL.buildProposalPrompt({ symbol: 'AAA', range: '5y', taLine: null })
    for (const k of [...SE.HYPOTHESIS_KEYS, 'donchian_breakout', 'range_breakout_atr', 'adx_trend']) expect(prompt).toContain(k)
    const out = SL.parseProposals(JSON.stringify({ proposals: [
      { strategy: 'donchian_breakout', params: { entryPeriod: 55, exitPeriod: 20 }, hypothesis: { worksIn: 'uptrend', statement: 'breakouts run in trends' } },
      { strategy: 'bb_reversion', params: {} },
    ] }))
    expect(out[0].hypothesis).toMatchObject({ worksIn: 'uptrend', source: 'model' })
    expect(out[1].hypothesis).toMatchObject({ worksIn: 'range', source: 'default' })
  })

  test('every evaluated proposal carries the test of its hypothesis against its own trades', () => {
    const g2 = rng(5), closes = [], highs = [], lows = []; let p = 100
    for (let i = 0; i < 900; i++) { p *= 1 + 0.0004 + 0.012 * g2.normal(); closes.push(p); highs.push(p * 1.006); lows.push(p * 0.994) }
    const ts = closes.map((_, i) => T0 + i * 86400)
    const out = SL.evaluateProposals([{ strategy: 'donchian_breakout', params: { entryPeriod: 20, exitPeriod: 10 } }, { strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 } }], ts, closes, 10000, { costBps: 10, highs, lows })
    for (const e of out) {
      expect(e.hypothesis).toMatchObject({ worksIn: 'uptrend', source: 'default' })
      expect(e.hypothesisTest).toHaveProperty('verdict')
    }
  })
})
