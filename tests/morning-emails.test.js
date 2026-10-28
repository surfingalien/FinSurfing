'use strict'

// The three morning emails (lib/scheduled-jobs.js + lib/morning-emails.js).
// The brief used to scan the same 20 hard-coded symbols every day, so it could
// only ever re-rank them. These pin that it now scans fresh universes, splits
// buys from avoids without padding, runs every persona independently, and
// researches the recipient's own holdings in rotation.

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key'
process.env.MORNING_BRIEF_EMAIL = 'me@finsurf.test'
delete process.env.ADMIN_EMAIL // the holdings job falls back to it; tests decide the account

const mockSend = jest.fn(async () => true)
jest.mock('../lib/email', () => ({ sendEmail: (...a) => mockSend(...a) }))
const mockUserId = jest.fn()
const mockHoldings = jest.fn()
jest.mock('../lib/user-holdings', () => ({
  userIdForEmail: (...a) => mockUserId(...a),
  holdingSymbols: (...a) => mockHoldings(...a),
}))

const me = require('../lib/morning-emails')
const jobs = require('../lib/scheduled-jobs')
const { PERSONAS } = require('../lib/investor-personas')

const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const pick = (symbol, compositeScore, over = {}) => ({ symbol, compositeScore, agentVerdict: 'Buy', actionable: true, ...over })
const avoid = (symbol, compositeScore, over = {}) => pick(symbol, compositeScore, { agentVerdict: 'Avoid', actionable: false, riskNote: `${symbol} risk`, ...over })
const bodyOf = call => JSON.parse(call[1].body)

let realFetch
beforeEach(() => {
  realFetch = global.fetch
  mockSend.mockClear(); mockUserId.mockReset(); mockHoldings.mockReset()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks() })

describe('splitBuysAvoids', () => {
  test('buys by score, avoids weakest first, a symbol seen twice counted once', () => {
    const out = me.splitBuysAvoids([
      { rankedStocks: [pick('AAA', 70), avoid('ZZZ', 30), pick('BBB', 80)], universeRequested: ['AAA', 'BBB', 'ZZZ', 'QQQ'] },
      { rankedStocks: [pick('AAA', 99), avoid('YYY', 20), pick('CCC', 75)], universeRequested: ['AAA', 'CCC', 'YYY'] },
    ])
    expect(out.buys.map(s => s.symbol)).toEqual(['BBB', 'CCC', 'AAA'])
    expect(out.buys.find(s => s.symbol === 'AAA').compositeScore).toBe(70) // first appearance wins
    expect(out.avoids.map(s => s.symbol)).toEqual(['YYY', 'ZZZ'])
    expect(out.scanned).toBe(6)
  })

  test('a Hold is neither a buy nor an avoid, and short lists are never padded', () => {
    const out = me.splitBuysAvoids([{ rankedStocks: [pick('AAA', 60), pick('HLD', 50, { agentVerdict: 'Hold', actionable: false }), avoid('ZZZ', 20)] }], { buys: 15, avoids: 10 })
    expect(out.buys.map(s => s.symbol)).toEqual(['AAA'])
    expect(out.avoids.map(s => s.symbol)).toEqual(['ZZZ'])
  })

  test('caps both lists', () => {
    const many = Array.from({ length: 30 }, (_, i) => pick(`B${i}`, i))
    const bad = Array.from({ length: 30 }, (_, i) => avoid(`A${i}`, i))
    const out = me.splitBuysAvoids([{ rankedStocks: [...many, ...bad] }], { buys: 15, avoids: 10 })
    expect(out.buys).toHaveLength(15)
    expect(out.avoids).toHaveLength(10)
    expect(out.buys[0].symbol).toBe('B29')
    expect(out.avoids[0].symbol).toBe('A0')
  })
})

describe('holdings rotation', () => {
  test('a weekday counter that advances by one per weekday and holds over the weekend', () => {
    const fri = me.businessDayIndex(new Date('2026-10-30T12:00:00Z'))
    expect(me.businessDayIndex(new Date('2026-10-29T12:00:00Z'))).toBe(fri - 1)
    expect(me.businessDayIndex(new Date('2026-10-31T12:00:00Z'))).toBe(fri) // Sat
    expect(me.businessDayIndex(new Date('2026-11-01T12:00:00Z'))).toBe(fri) // Sun
    expect(me.businessDayIndex(new Date('2026-11-02T12:00:00Z'))).toBe(fri + 1) // Mon
  })

  test('8 or fewer holdings are all researched daily', () => {
    expect(me.rotateSlice(['B', 'A', 'A', 'C'], 8, 123)).toEqual(['A', 'B', 'C'])
  })

  test('more than 8: consecutive weekdays cover every holding', () => {
    const syms = Array.from({ length: 19 }, (_, i) => `S${String(i).padStart(2, '0')}`)
    const seen = new Set()
    for (let d = 100; d < 103; d++) {
      const today = me.rotateSlice(syms, 8, d)
      expect(today).toHaveLength(8)
      today.forEach(s => seen.add(s))
    }
    expect(seen.size).toBe(19)
  })
})

describe('HTML', () => {
  test('model text is escaped, abstentions and failures are stated', () => {
    const [def, buffett, lynch] = Object.values(PERSONAS)
    const html = me.buildStrategyDeskHtml({
      dateStr: 'Wed, Oct 28',
      results: [
        { persona: def, data: { marketOutlook: 'Calm <b>tape</b>', recommendations: [{ symbol: 'NVDA', entryPrice: 100, takeProfitPrice: 115, targetReturn: 15, stopLossPrice: 94, stopLoss: 6, thesis: '<script>x</script>', expectedValue: { netEdge: 0.0123 } }] } },
        { persona: buffett, data: { recommendations: [], abstained: true } },
        { persona: lynch, error: 'timeout' },
      ],
    })
    expect(html).not.toMatch(/<script>|<b>tape/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('1.23%')
    expect(html).toMatch(/abstained/)
    expect(html).toMatch(/failed today: timeout/)
  })

  test('holdings: verdict, checked claims, plan, deep link and what is next', () => {
    const html = me.buildHoldingsResearchHtml({
      dateStr: 'Wed, Oct 28', appUrl: 'https://app.test',
      holdings: ['AAPL', 'MSFT', 'NVDA'],
      results: [
        { symbol: 'NVDA', data: { company: 'NVIDIA', lastPrice: 180, judgement: { verdict: 'actionable', reasons: ['+1.2% expected'], bull: [{ claim: 'ROIC 60%' }], bear: [{ claim: 'P/E 50' }], zones: { entryLow: 176, entryHigh: 184, target: 207, stop: 169, targetReturn: 15, stopLoss: 6 }, horizonDays: 30, invalidation: 'Data-centre orders fall' } } },
        { symbol: 'MSFT', error: 'HTTP 502' },
      ],
    })
    expect(html).toContain('Actionable long')
    expect(html).toContain('ROIC 60%')
    expect(html).toContain('$207.00')
    expect(html).toContain('https://app.test/#/research-desk/NVDA')
    expect(html).toMatch(/Research failed today: HTTP 502/)
    expect(html).toMatch(/still to come: AAPL/)
  })
})

describe('morning brief (buy / avoid)', () => {
  test('two fresh stock scans, not a fixed list; buys and avoids in one email', async () => {
    let n = 0
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).includes('/api/macro/indicators')) return json({ regime: { regime: 'Neutral / Balanced' } })
      n++
      return json(n === 1
        ? { rankedStocks: [pick('AAA', 80), avoid('ZZZ', 25)], universeRequested: ['AAA', 'ZZZ'] }
        : { rankedStocks: [pick('BBB', 70), avoid('YYY', 30)], universeRequested: ['BBB', 'YYY'] })
    })
    const out = await jobs._morningBriefEmailForTests()
    const scanCalls = global.fetch.mock.calls.filter(c => String(c[0]).includes('/api/ai-brain/analyze'))
    expect(scanCalls).toHaveLength(2)
    for (const c of scanCalls) {
      expect(bodyOf(c).scanMode).toBe('stocks')
      expect(bodyOf(c).symbols).toBeUndefined()
    }
    expect(out).toMatchObject({ stockCount: 2, avoidCount: 2, scanned: 4 })
    const mail = mockSend.mock.calls[0][0]
    expect(mail.to).toBe('me@finsurf.test')
    expect(mail.subject).toMatch(/2 to buy, 2 to avoid/)
    expect(mail.html).toContain('ZZZ risk')
    expect(mail.html).toMatch(/2 Stocks to Avoid/)
    // Each scan ranks its own picks from 1, so the merged list is numbered by position.
    expect(mail.html).not.toContain('undefined')
  })

  test('one failed scan still sends; both failing is a failed run', async () => {
    let n = 0
    global.fetch = jest.fn(async url => {
      if (String(url).includes('/api/macro/indicators')) return json({})
      n++
      return n === 1 ? json({ error: 'upstream overloaded' }) : json({ rankedStocks: [pick('AAA', 80)] })
    })
    expect((await jobs._morningBriefEmailForTests()).scansFailed).toBe(1)

    global.fetch = jest.fn(async url => (String(url).includes('/api/macro') ? json({}) : json({ error: 'upstream overloaded' })))
    await expect(jobs._morningBriefEmailForTests()).rejects.toThrow(/upstream overloaded/)
  })
})

describe('strategy desk', () => {
  test('every persona runs independently (no userId, so no shared "recent picks"); a failure is reported, not fatal', async () => {
    global.fetch = jest.fn(async (url, opts) => {
      const { persona } = JSON.parse(opts.body)
      return persona === 'burry' ? json({ error: 'model timeout' }) : json({ recommendations: [{ symbol: `${persona.toUpperCase()}1`, entryPrice: 10 }], marketOutlook: 'ok' })
    })
    const out = await jobs._strategyDeskEmailForTests()
    const bodies = global.fetch.mock.calls.map(bodyOf)
    expect(bodies.map(b => b.persona)).toEqual(Object.keys(PERSONAS))
    bodies.forEach(b => expect(b.userId).toBeUndefined())
    expect(out.personas.find(p => p.id === 'burry').error).toMatch(/model timeout/)
    expect(mockSend.mock.calls[0][0].subject).toMatch(/10 personas/)
  })

  test('every persona failing is a failed run, not an empty email', async () => {
    global.fetch = jest.fn(async () => json({ error: 'AI unavailable' }))
    await expect(jobs._strategyDeskEmailForTests()).rejects.toThrow(/every persona run failed/)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('holdings research', () => {
  test("researches the recipient's holdings, saved under their account", async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['AAPL', 'NVDA'])
    global.fetch = jest.fn(async url => json({ symbol: String(url).split('/')[5], judgement: { verdict: String(url).includes('NVDA') ? 'actionable' : 'no-trade', reasons: [] } }))
    const out = await jobs._holdingsResearchEmailForTests()
    expect(mockUserId).toHaveBeenCalledWith('me@finsurf.test')
    expect(global.fetch.mock.calls.map(c => c[0])).toEqual([
      expect.stringMatching(/\/api\/research-desk\/AAPL\/thesis$/),
      expect.stringMatching(/\/api\/research-desk\/NVDA\/thesis$/),
    ])
    global.fetch.mock.calls.forEach(c => expect(bodyOf(c)).toEqual({ method: 'single', userId: 'user-1' }))
    expect(mockSend.mock.calls[0][0].subject).toMatch(/2 holding\(s\), 1 actionable/)
    expect(out.researched).toHaveLength(2)
  })

  test('caps the day at 8 holdings', async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(Array.from({ length: 20 }, (_, i) => `S${String(i).padStart(2, '0')}`))
    global.fetch = jest.fn(async () => json({ judgement: { verdict: 'no-trade', reasons: [] } }))
    await jobs._holdingsResearchEmailForTests()
    expect(global.fetch).toHaveBeenCalledTimes(8)
  })

  test('no account or no holdings is a skip with the reason, and nothing is sent', async () => {
    mockUserId.mockResolvedValue(null)
    expect((await jobs._holdingsResearchEmailForTests()).skipped).toBe(true)
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue([])
    expect((await jobs._holdingsResearchEmailForTests()).reason).toMatch(/no holdings/)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
