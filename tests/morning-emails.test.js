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

// Second Brain notes: the holdings job reads the previous verdict + the user's
// own note and saves today's thesis; the Sunday job counts notes to consolidate.
const mockLatest = jest.fn(async () => [])
const mockCreate = jest.fn(async (userId, note) => ({ id: 'n1', user_id: userId, ...note }))
jest.mock('../lib/notes-store', () => ({
  RESEARCH_DESK_TAG: 'research-desk',
  latestNotes: (...a) => mockLatest(...a),
  createNote: (...a) => mockCreate(...a),
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
  mockLatest.mockReset(); mockLatest.mockResolvedValue([]); mockCreate.mockClear()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); jest.restoreAllMocks() })

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
  test('persona email: model text is escaped, net edge shown as a percent', () => {
    const html = me.buildPersonaHtml({
      persona: PERSONAS.buffett, dateStr: 'Wed, Oct 28',
      data: { marketOutlook: 'Calm <b>tape</b>', recommendations: [{ symbol: 'NVDA', entryPrice: 100, takeProfitPrice: 115, targetReturn: 15, stopLossPrice: 94, stopLoss: 6, thesis: '<script>x</script>', expectedValue: { netEdge: 0.0123 } }] },
    })
    expect(html).toContain('Warren Buffett')
    expect(html).not.toMatch(/<script>|<b>tape/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('1.23%')
  })

  test('an abstaining persona says so; failures are listed with their reasons', () => {
    expect(me.buildPersonaHtml({ persona: PERSONAS.lynch, dateStr: 'Wed', data: { recommendations: [] } })).toMatch(/abstained/)
    const html = me.buildPersonaFailuresHtml({ dateStr: 'Wed', total: 10, failures: [{ persona: PERSONAS.burry, error: 'HTTP 503 <AI>' }] })
    expect(html).toContain('Michael Burry')
    expect(html).toContain('HTTP 503 &lt;AI&gt;')
    expect(html).toMatch(/1 of 10 persona run\(s\) failed/)
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
  test('one email per persona, run independently (no userId, so no shared "recent picks"); failures in one summary', async () => {
    global.fetch = jest.fn(async (url, opts) => {
      const { persona } = JSON.parse(opts.body)
      if (persona === 'burry') return json({ error: 'model timeout' })
      if (persona === 'marks') return json({ recommendations: [], abstained: true })
      return json({ recommendations: [{ symbol: `${persona.toUpperCase()}1`, entryPrice: 10 }], marketOutlook: 'ok' })
    })
    const out = await jobs._strategyDeskEmailForTests()
    const bodies = global.fetch.mock.calls.map(bodyOf)
    expect(bodies.map(b => b.persona)).toEqual(Object.keys(PERSONAS))
    bodies.forEach(b => expect(b.userId).toBeUndefined())
    const subjects = mockSend.mock.calls.map(c => c[0].subject)
    expect(subjects).toHaveLength(10) // 9 persona emails (the abstain included) + 1 failure summary
    expect(subjects.filter(s => /Warren Buffett — 1 pick —/.test(s))).toHaveLength(1)
    expect(subjects.filter(s => /Howard Marks — no picks today/.test(s))).toHaveLength(1)
    expect(subjects.some(s => /Michael Burry/.test(s))).toBe(false)
    expect(subjects.at(-1)).toMatch(/1 of 10 persona run\(s\) failed/)
    expect(out.personas.find(p => p.id === 'burry').error).toMatch(/model timeout/)
  })

  test('an outage is one email, not ten, and a failed run', async () => {
    global.fetch = jest.fn(async () => json({ error: 'AI unavailable' }))
    await expect(jobs._strategyDeskEmailForTests()).rejects.toThrow(/every persona run failed/)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend.mock.calls[0][0].subject).toMatch(/10 of 10 persona run\(s\) failed/)
  })

  test('a rejected send does not stop the personas after it; it is reported in the summary', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    global.fetch = jest.fn(async (url, opts) => json({ recommendations: [{ symbol: JSON.parse(opts.body).persona.toUpperCase(), entryPrice: 10 }] }))
    mockSend.mockImplementation(async ({ subject }) => {
      if (/Warren Buffett/.test(subject)) throw new Error('Resend error 503 (after 3 attempts)')
      return true
    })
    try {
      const out = await jobs._strategyDeskEmailForTests()
      expect(global.fetch).toHaveBeenCalledTimes(10) // every persona still ran
      const buffett = out.personas.find(p => p.id === 'buffett')
      expect(buffett.sent).toBe(false)
      expect(buffett.error).toMatch(/email was not sent: Resend error 503/)
      expect(mockSend.mock.calls.at(-1)[0].subject).toMatch(/1 of 10 persona run\(s\) failed/)
    } finally { mockSend.mockImplementation(async () => true) }
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

// A + B: every holdings thesis is saved to the Second Brain with its verdict,
// and the next email says whether the verdict changed and quotes the user's
// own latest note.
describe('holdings research → Second Brain', () => {
  const actionable = { company: 'NVIDIA', lastPrice: 180, judgement: { verdict: 'actionable', reasons: ['+1.2% expected'], bull: [{ claim: 'ROIC 60%' }], bear: [], zones: { entryLow: 176, entryHigh: 184, target: 207, stop: 169, targetReturn: 15, stopLoss: 6 }, horizonDays: 30, invalidation: 'Orders fall' } }

  test("each thesis is saved as a tagged note under the owner's account", async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['NVDA'])
    global.fetch = jest.fn(async () => json(actionable))
    const out = await jobs._holdingsResearchEmailForTests()
    expect(mockCreate).toHaveBeenCalledWith('user-1', expect.objectContaining({
      symbol: 'NVDA', note_type: 'thesis', tags: ['research-desk', 'verdict:actionable'],
      title: expect.stringMatching(/^Research Desk · NVDA · .* · Actionable long$/),
    }))
    const content = mockCreate.mock.calls[0][1].content
    expect(content).toMatch(/\*\*Verdict: Actionable long\*\*/)
    expect(content).toMatch(/- ROIC 60%/)
    expect(content).toMatch(/#\/research-desk\/NVDA/)
    expect(out.researched[0].noteSaved).toBe(true)
  })

  test('the email says the verdict changed and shows the latest own note; reads happen before today is saved', async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['NVDA'])
    mockLatest.mockImplementation(async (uid, sym, opts) => opts.withTag
      ? [{ tags: ['research-desk', 'verdict:no-trade'], created_at: '2026-10-27T11:50:00Z' }]
      : [{ title: 'Why I hold NVDA', updated_at: '2026-10-20T09:00:00Z' }])
    global.fetch = jest.fn(async () => json(actionable))
    await jobs._holdingsResearchEmailForTests()
    const html = mockSend.mock.calls[0][0].html
    expect(html).toMatch(/Changed<\/strong> since 2026-10-27: was No trade, now Actionable long/)
    expect(html).toMatch(/Your latest note: “Why I hold NVDA” \(2026-10-20\)/)
    expect(mockLatest.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0])
  })

  test('a failed note save never fails the email', async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['NVDA'])
    mockCreate.mockRejectedValueOnce(new Error('db down'))
    global.fetch = jest.fn(async () => json(actionable))
    const out = await jobs._holdingsResearchEmailForTests()
    expect(out.researched[0]).toMatchObject({ verdict: 'actionable', noteSaved: false })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  test('verdictOfNote reads the tag; an untagged note has none', () => {
    expect(me.verdictOfNote({ tags: ['research-desk', 'verdict:no-trade'] })).toBe('no-trade')
    expect(me.verdictOfNote({ tags: ['x'] })).toBeNull()
  })
})

// C: the routine's weekly step, emailed on Sundays.
describe('Second Brain weekly email', () => {
  const lint = { issues: [{ severity: 'error', title: 'AAPL', message: 'Note1 bullish, Note2 bearish' }, { severity: 'warning', title: 'TSLA', message: 'TSLA is in your portfolio but has no research notes' }], score: 77, noteCount: 12 }

  test('runs Weekly Synthesis and Lint for the owner, with their holdings', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-15T14:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] }) // third Sunday
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['AAPL', 'TSLA'])
    global.fetch = jest.fn(async url => json(String(url).includes('weekly-synthesis')
      ? { title: 'Weekly Synthesis', content: '## Emerging Themes\n- AI capex <script>x</script>\n**Bold** point' }
      : lint))
    const out = await jobs._secondBrainWeeklyEmailForTests()
    const [synthCall, lintCall] = global.fetch.mock.calls
    expect(synthCall[0]).toMatch(/\/api\/research-notes\/weekly-synthesis$/)
    expect(bodyOf(synthCall)).toEqual({ userId: 'user-1' })
    expect(bodyOf(lintCall)).toEqual({ userId: 'user-1', portfolioSymbols: ['AAPL', 'TSLA'] })
    const { subject, html } = mockSend.mock.calls[0][0]
    expect(subject).toMatch(/health 77\/100/)
    expect(html).toContain('Emerging Themes')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toMatch(/Contradictions \(1\)/)
    expect(html).toMatch(/Your research routine/)
    expect(out.consolidate).toBeNull() // not the first Sunday
    expect(mockLatest).not.toHaveBeenCalled()
  })

  test("first Sunday of the month lists holdings to consolidate, counting only the user's own notes", async () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T14:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] })
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue(['AAPL', 'TSLA'])
    mockLatest.mockImplementation(async (uid, sym) => (sym === 'AAPL' ? [{}, {}, {}, {}] : [{}]))
    global.fetch = jest.fn(async url => json(String(url).includes('weekly-synthesis') ? { content: 'x' } : lint))
    const out = await jobs._secondBrainWeeklyEmailForTests()
    expect(out.consolidate).toEqual([{ symbol: 'AAPL', count: 4 }])
    mockLatest.mock.calls.forEach(c => expect(c[2]).toMatchObject({ withoutTag: 'research-desk' }))
    expect(mockSend.mock.calls[0][0].subject).toMatch(/1 to consolidate/)
  })

  test('a quiet week (no notes) still sends the health check; both failing is a failed run', async () => {
    mockUserId.mockResolvedValue('user-1')
    mockHoldings.mockResolvedValue([])
    global.fetch = jest.fn(async url => (String(url).includes('weekly-synthesis')
      ? { ok: false, status: 400, json: async () => ({}), text: async () => '{"error":"No notes created or updated in the last 7 days"}' }
      : json(lint)))
    const out = await jobs._secondBrainWeeklyEmailForTests()
    expect(out.synthesis).toMatch(/nothing to synthesise/)
    expect(mockSend.mock.calls[0][0].html).toMatch(/nothing to synthesise/)

    global.fetch = jest.fn(async () => json({ error: 'AI service not configured' }))
    await expect(jobs._secondBrainWeeklyEmailForTests()).rejects.toThrow(/both failed/)
  })
})
