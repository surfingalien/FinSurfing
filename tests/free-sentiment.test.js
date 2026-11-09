'use strict'
const FS = require('../lib/free-sentiment')

const msg = (sent, minsAgo) => ({ created_at: new Date(Date.UTC(2026, 10, 9, 12) - minsAgo * 60000).toISOString(), entities: { sentiment: sent ? { basic: sent } : null } })

describe('free sentiment sources', () => {
  beforeEach(() => FS._resetForTests())

  test('StockTwits: counts only what authors tagged, and refuses a lean on too few tags', () => {
    const many = { symbol: { watchlist_count: 1000 }, messages: [...Array(6).fill('Bullish'), ...Array(2).fill('Bearish'), ...Array(22).fill(null)].map((s, i) => msg(s, i * 10)) }
    const r = FS.foldStockTwits(many)
    expect(r).toMatchObject({ messages: 30, tagged: 8, bullish: 6, bearish: 2, bullShare: 0.75, watchers: 1000 })
    expect(r.perHour).toBeCloseTo(30 / (290 / 60), 1)
    expect(FS.foldStockTwits({ messages: [msg('Bullish', 0), msg('Bullish', 5)] }).bullShare).toBeNull()
    expect(FS.foldStockTwits({})).toBeNull()
  })

  test('ApeWisdom: first-seen rank per ticker, and the change in RANK (its 24h-ago mention count is a different window)', () => {
    const m = FS.foldApe([{ count: 600, results: [{ rank: 3, ticker: 'AMD', mentions: 242, mentions_24h_ago: 26, upvotes: 730, rank_24h_ago: 17 }] }])
    expect(m.get('AMD')).toMatchObject({ rank: 3, mentions: 242, of: 600 })
    const s = FS.summarise('amd', { reddit: m.get('AMD') })
    expect(s.reddit.rankChange).toBe(14)
    expect(s.reddit).not.toHaveProperty('change24h')
    expect(FS.describeLine(s)).toMatch(/rank 3 of 600, 242 mentions in 24h \(up 14 places since yesterday\)/)
    expect(s.lean).toBe('quiet')   // mentions are attention, not direction
  })

  test('lean counts only the directional sources and never blends them into a score', () => {
    const twits = { messages: 30, tagged: 10, bullish: 8, bearish: 2, bullShare: 0.8 }
    expect(FS.summarise('A', { twits, news: { total: 4, rawTotal: 6, bullCount: 3, bearCount: 0, syndicated: true, headlines: [] } }).lean).toBe('bullish')
    expect(FS.summarise('A', { twits, news: { total: 4, bullCount: 0, bearCount: 3, headlines: [] } }).lean).toBe('mixed')
    expect(FS.summarise('A', { twits: { ...twits, bullShare: 0.5 } }).lean).toBe('neutral')
    const line = FS.describeLine(FS.summarise('A', { twits, news: { total: 4, rawTotal: 6, bullCount: 3, bearCount: 0, syndicated: true, headlines: [] } }))
    expect(line).toMatch(/StockTwits: 10 of the last 30 messages self-tagged \(80% bullish\)/)
    expect(line).toMatch(/News: 4 distinct stories \(6 articles\)/)
  })

  test('fetchers fail soft and cache: one network call per symbol within the window', async () => {
    let calls = 0
    const ok = async () => { calls++; return { ok: true, json: async () => ({ messages: [msg('Bullish', 0)] }) } }
    expect(await FS.stockTwits('AAPL', { fetchImpl: ok })).toMatchObject({ messages: 1 })
    await FS.stockTwits('AAPL', { fetchImpl: ok })
    expect(calls).toBe(1)
    expect(await FS.stockTwits('MSFT', { fetchImpl: async () => { throw new Error('down') } })).toBeNull()
    expect(await FS.apeWisdom('ZZZZ', { fetchImpl: async () => ({ ok: true, json: async () => ({ pages: 1, count: 1, results: [{ ticker: 'NVDA', rank: 1, mentions: 5 }] }) }) })).toMatchObject({ notRanked: true })
  })
})
