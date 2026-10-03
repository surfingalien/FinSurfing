'use strict'

const { cachedSystem, markConversationTail, cacheUsage } = require('../lib/prompt-cache')

describe('cachedSystem', () => {
  test('the stable block carries the mark; the volatile part follows unmarked', () => {
    const blocks = cachedSystem('RULES', '\nUser context — Portfolio: NVDA')
    expect(blocks).toEqual([
      { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\nUser context — Portfolio: NVDA' },
    ])
  })

  test('an empty volatile part adds no block (a blank text block is an API error)', () => {
    expect(cachedSystem('RULES', '')).toHaveLength(1)
    expect(cachedSystem('RULES', '   ')).toHaveLength(1)
    expect(cachedSystem('RULES')).toHaveLength(1)
  })
})

describe('markConversationTail', () => {
  const marks = msgs => msgs.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.cache_control).length

  test('marks exactly the last block of the last message, converting a string to a text block', () => {
    const out = markConversationTail([{ role: 'user', content: 'hi' }])
    expect(out[0].content).toEqual([{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }])
  })

  test('a tool loop keeps ONE conversation mark, on the newest block — never piling up past the API limit of 4', () => {
    let history = [{ role: 'user', content: 'scan tech' }]
    for (let round = 0; round < 6; round++) {
      history = markConversationTail(history)
      history.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${round}`, name: 'scan', input: {} }] })
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${round}`, content: '{}' }] })
    }
    const out = markConversationTail(history)
    expect(marks(out)).toBe(1)
    expect(out.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
  })

  test("never mutates the caller's history (it is replayed on the next round)", () => {
    const history = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }]
    const snapshot = JSON.stringify(history)
    markConversationTail(history)
    expect(JSON.stringify(history)).toBe(snapshot)
  })

  test('empty input passes through', () => {
    expect(markConversationTail([])).toEqual([])
  })
})

describe('cacheUsage', () => {
  test('reads both cache fields; absent usage is unknown, not zero', () => {
    expect(cacheUsage({ input_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }))
      .toEqual({ cacheRead: 4000, cacheWrite: 0 })
    expect(cacheUsage(null)).toEqual({ cacheRead: null, cacheWrite: null })
  })
})

describe('ai-router sends the system prompt as a cached block', () => {
  let create
  beforeEach(() => {
    jest.resetModules()
    create = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 },
    })
    jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create } })))
    process.env.ANTHROPIC_API_KEY = 'test'
  })
  afterEach(() => { jest.dontMock('@anthropic-ai/sdk'); delete process.env.ANTHROPIC_API_KEY })

  test('stable system marked, volatile system after it, cache usage reported', async () => {
    const { AIRouter } = require('../lib/ai-router')
    const out = await new AIRouter('t-cache').call({ prompt: 'data', system: 'RULES', systemVolatile: '\nctx' })
    const params = create.mock.calls[0][0]
    expect(params.system).toEqual([
      { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\nctx' },
    ])
    expect(params.messages).toEqual([{ role: 'user', content: 'data' }])
    expect(out).toMatchObject({ text: 'ok', cacheRead: 1800, cacheWrite: 0 })
  })

  test('no system prompt → no system field at all', async () => {
    const { AIRouter } = require('../lib/ai-router')
    await new AIRouter('t-cache-2').call({ prompt: 'data' })
    expect(create.mock.calls[0][0]).not.toHaveProperty('system')
  })
})

describe('ai-audit prices cached tokens', () => {
  const { estimateCost } = require('../lib/ai-audit')

  test('input_tokens is only the uncached part; reads bill at 0.1x, writes at 1.25x', () => {
    // sonnet-4-6: $3/MTok in. 1M uncached = $3; 1M read = $0.30; 1M written = $3.75.
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 0)).toBe(3)
    expect(estimateCost('claude-sonnet-4-6', 0, 0, { cacheRead: 1_000_000 })).toBe(0.3)
    expect(estimateCost('claude-sonnet-4-6', 0, 0, { cacheWrite: 1_000_000 })).toBe(3.75)
  })

  test('no cache fields → the old figure, unchanged', () => {
    expect(estimateCost('claude-sonnet-4-6', 2000, 500)).toBe(+((2000 * 3 + 500 * 15) / 1e6).toFixed(6))
  })
})
