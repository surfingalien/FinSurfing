'use strict'

// lib/plan-check.js: the AI Agent, the Agent Hub pipeline and the Analyze page
// wrote entry/target/stop plans that nothing checked (a BUY with its target
// below its entry would ship) and none were recorded for scoring.

const pc = require('../lib/plan-check')

const wp = p => ({ p, source: 'test' })

describe('checkPlan', () => {
  test('a coherent long that pays after costs is "act", with reward/risk and the break-even rate', () => {
    const c = pc.checkPlan({ side: 'long', entry: 100, target: 115, stop: 95, price: 100, assetType: 'stock', winProb: wp(0.5) })
    expect(c).toMatchObject({ verdict: 'act', ok: true, targetReturn: 15, stopLoss: 5, rr: 3 })
    expect(c.breakEvenWinProb).toBeGreaterThan(0.25)
    expect(c.breakEvenWinProb).toBeLessThan(0.3)
  })

  test('a long whose target is below its entry is rejected and says why — never repaired', () => {
    const c = pc.checkPlan({ side: 'long', entry: 100, target: 95, stop: 90, price: 100, winProb: wp(0.5) })
    expect(c).toMatchObject({ verdict: 'incoherent', ok: false })
    expect(c.reasons.join(' ')).toMatch(/Target \$95 is not above the entry \$100/)
  })

  test('a short needs the mirror image: target below, stop above', () => {
    expect(pc.checkPlan({ side: 'short', entry: 100, target: 90, stop: 104, price: 100, winProb: wp(0.5) }).verdict).toBe('act')
    expect(pc.checkPlan({ side: 'short', entry: 100, target: 110, stop: 95, price: 100, winProb: wp(0.5) }).verdict).toBe('incoherent')
  })

  test('an entry far from the current price is a remembered price, not a pullback plan', () => {
    const far = pc.checkPlan({ side: 'long', entry: 150, target: 170, stop: 140, price: 100, winProb: wp(0.5) })
    expect(far.verdict).toBe('incoherent')
    expect(far.reasons.join(' ')).toMatch(/50% from the current price/)
    const near = pc.checkPlan({ side: 'long', entry: 96, target: 110, stop: 92, price: 100, winProb: wp(0.5) })
    expect(near.verdict).not.toBe('incoherent')
    expect(near.reasons.join(' ')).toMatch(/needs the price to get there first/)
  })

  test('a payoff that does not clear its costs at the measured win rate is rejected', () => {
    const c = pc.checkPlan({ side: 'long', entry: 100, target: 104, stop: 92, price: 100, winProb: wp(0.5) })
    expect(c.verdict).toBe('reject')
    expect(c.ok).toBe(false)
  })

  test('no view is no trade; a missing level is named', () => {
    expect(pc.checkPlan({ side: null }).verdict).toBe('no-trade')
    expect(pc.checkPlan({ side: 'long', entry: 100, target: 110 }).reasons[0]).toMatch(/no stop/)
  })

  test('without a measured rate the default 50% is used and labelled', () => {
    const c = pc.checkPlan({ side: 'long', entry: 100, target: 115, stop: 95 })
    expect(c.winProb).toBe(0.5)
    expect(c.winProbSource).toMatch(/calibration pending/)
  })
})

describe('parseTradeHypothesis', () => {
  const answer = `**Executive Summary** — Bullish.

**Trade Hypothesis**
- **Bias:** Bullish
- Entry zone: $188.50 – $191.00
- Target 1: $205.00 (R/R: 2.4:1)  |  Target 2: $215.00
- Stop loss: $182.00 (based on ATR)
- Risk/Reward: 2.4:1`

  test('reads the labelled lines the agent is told to write', () => {
    expect(pc.parseTradeHypothesis(answer)).toEqual({
      bias: 'bullish', side: 'long', entryLow: 188.5, entryHigh: 191, entry: 189.75,
      target: 205, target2: 215, stop: 182,
    })
  })

  test('a bearish view is a short; neutral is no trade; no Bias line is no plan', () => {
    expect(pc.parseTradeHypothesis('- Bias: Bearish\n- Entry zone: $50\n- Target 1: $44\n- Stop-loss: $53').side).toBe('short')
    expect(pc.parseTradeHypothesis('- Bias: Neutral').side).toBeNull()
    expect(pc.parseTradeHypothesis('RSI is 44.')).toBeNull()
  })

  test('commas in prices are read as thousands', () => {
    expect(pc.parseTradeHypothesis('Bias: Bullish\nEntry zone: $1,180 – $1,200\nTarget 1: $1,320\nStop loss: $1,120').entry).toBe(1190)
  })
})

describe('recordPlan', () => {
  const store = () => ({ recordDecision: jest.fn(d => d) })
  const check = pc.checkPlan({ side: 'long', entry: 100, target: 115, stop: 95, price: 100, winProb: wp(0.5) })
  beforeEach(() => pc._resetForTests())

  test('a directional plan is recorded once per surface, symbol and direction a day', () => {
    const s = store()
    pc.recordPlan({ surface: 'ai-agent', symbol: 'nvda', check, price: 100 }, s)
    pc.recordPlan({ surface: 'ai-agent', symbol: 'NVDA', check, price: 101 }, s)
    pc.recordPlan({ surface: 'trading-analysis', symbol: 'NVDA', check, price: 101 }, s)
    expect(s.recordDecision).toHaveBeenCalledTimes(2)
    expect(s.recordDecision.mock.calls[0][0]).toMatchObject({ surface: 'ai-agent', symbol: 'nvda', action: 'buy', price: 100, meta: { entry: 100, target: 115, stop: 95, verdict: 'act' } })
  })

  test('an incoherent plan, no view, or no price is not a decision', () => {
    const s = store()
    pc.recordPlan({ surface: 'ai-agent', symbol: 'A', check: pc.checkPlan({ side: 'long', entry: 100, target: 90, stop: 95, winProb: wp(0.5) }), price: 100 }, s)
    pc.recordPlan({ surface: 'ai-agent', symbol: 'B', check: pc.checkPlan({ side: null }), price: 100 }, s)
    pc.recordPlan({ surface: 'ai-agent', symbol: 'C', check, price: null }, s)
    expect(s.recordDecision).not.toHaveBeenCalled()
  })

  test('the surfaces exist in the learning store', () => {
    const ls = require('../lib/learning-store')
    expect(() => ls.buildDecision({ surface: 'ai-agent', symbol: 'A', action: 'buy' })).not.toThrow()
    expect(() => ls.buildDecision({ surface: 'agent-hub', symbol: 'A', action: 'buy' })).not.toThrow()
  })
})

test('describeCheck says what was checked in one line', () => {
  const line = pc.describeCheck(pc.checkPlan({ side: 'long', entry: 100, target: 115, stop: 95, winProb: wp(0.5) }))
  expect(line).toMatch(/^Plan checks out: long from \$100, target \$115 \(\+15%\), stop \$95 \(−5%\), reward\/risk 3:1/)
  expect(pc.describeCheck(pc.checkPlan({ side: 'long', entry: 100, target: 90, stop: 95 }))).toMatch(/^Plan rejected by code:/)
})
