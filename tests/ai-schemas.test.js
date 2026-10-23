'use strict'

// Constrained decoding: every registered schema must be one BOTH providers
// accept (a schema the API refuses would otherwise surface only in production),
// and the router must send it — and survive a refusal.

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })))

const os = require('../lib/output-schema')
const { SCHEMAS, SCAN_SCHEMA, THESIS_SCHEMA } = require('../lib/ai-schemas')
const { AIRouter, refusedSchemas, _resetSchemasForTests } = require('../lib/ai-router')

describe('lintSchema', () => {
  test.each(Object.entries(SCHEMAS))('%s is accepted by both providers', (_name, schema) => {
    expect(os.lintSchema(schema)).toEqual([])
  })

  test('rejects what either API would refuse', () => {
    const bad = {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 0 },
        note:  { type: 'string' },
        list:  { type: 'array', items: { type: 'string' }, minItems: 2 },
        inner: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      },
      required: ['score', 'list', 'inner'],
      additionalProperties: false,
    }
    const p = os.lintSchema(bad).join('\n')
    expect(p).toMatch(/score: "minimum" is not supported/)
    expect(p).toMatch(/must be required .* note/)
    expect(p).toMatch(/list: minItems may only be 0 or 1/)
    expect(p).toMatch(/inner: object needs additionalProperties: false/)
  })

  test('counts unions against the limit, and needs an object root', () => {
    const props = Object.fromEntries(Array.from({ length: os.MAX_UNIONS + 1 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }]))
    expect(os.lintSchema(os.obj(props)).join()).toMatch(/unions — the limit is 16/)
    expect(os.lintSchema(os.arr(os.str())).join()).toMatch(/root must be an object/)
  })
})

describe('canonicalizeEnums', () => {
  test('restores the declared spelling of an enum, nested in arrays and objects', () => {
    const out = os.canonicalizeEnums(SCAN_SCHEMA, {
      dataSource: 'Live',
      rankedStocks: [{ symbol: 'NVDA', agentVerdict: 'strong buy', confidence: 'HIGH', volumeSignal: 'Confirming' }],
    })
    expect(out.dataSource).toBe('live')
    expect(out.rankedStocks[0]).toMatchObject({ agentVerdict: 'Strong Buy', confidence: 'High', volumeSignal: 'Confirming', symbol: 'NVDA' })
  })
  test('leaves a value that matches nothing alone — the surface decides what to do with it', () => {
    expect(os.canonicalizeEnums(SCAN_SCHEMA, { rankedStocks: [{ agentVerdict: 'Sell' }] }).rankedStocks[0].agentVerdict).toBe('Sell')
  })
})

test('the thesis horizon enum is the Research Desk HORIZONS list', () => {
  expect(THESIS_SCHEMA.properties.horizonDays.enum).toEqual(require('../lib/research-desk').HORIZONS)
})

describe('router', () => {
  const schema = os.obj({ verdict: os.oneOf(['Buy', 'Avoid']) })
  const okMsg = { content: [{ type: 'text', text: '{"verdict":"Buy"}' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' }
  let realFetch
  beforeEach(() => {
    mockCreate.mockReset(); _resetSchemasForTests()
    process.env.ANTHROPIC_API_KEY = 'k'; delete process.env.CLAUDE_PAUSE_UNTIL
    realFetch = global.fetch
  })
  afterEach(() => { global.fetch = realFetch; delete process.env.GROQ_API_KEY })

  test('Claude: the schema travels as output_config.format; without one, nothing is added', async () => {
    mockCreate.mockResolvedValue(okMsg)
    const r = new AIRouter('t-claude')
    const out = await r.call({ prompt: 'p', schema, schemaName: 's1' })
    expect(mockCreate.mock.calls[0][0].output_config).toEqual({ format: { type: 'json_schema', schema } })
    expect(out).toMatchObject({ text: '{"verdict":"Buy"}', constrained: true, stopReason: 'end_turn' })
    await r.call({ prompt: 'p' })
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('output_config')
  })

  test('Claude: a refused schema is switched off and the call reruns unconstrained', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('output_config.format.schema: Schema is too complex for compilation'), { status: 400 }))
      .mockResolvedValue(okMsg)
    const r = new AIRouter('t-refused', { threshold: 10 })
    const out = await r.call({ prompt: 'p', schema, schemaName: 's2' })
    expect(out.constrained).toBe(false)
    expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('output_config')
    expect(refusedSchemas()).toContain('claude:s2')
    await r.call({ prompt: 'p', schema, schemaName: 's2' })
    expect(mockCreate.mock.calls[2][0]).not.toHaveProperty('output_config')   // stays off
    console.warn.mockRestore()
  })

  test('Claude: an ordinary 400 is not mistaken for a schema refusal', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('messages: roles must alternate'), { status: 400 }))
    await expect(new AIRouter('t-400', { threshold: 10 }).call({ prompt: 'p', schema, schemaName: 's3' })).rejects.toThrow(/alternate/)
    expect(refusedSchemas()).toEqual([])
  })

  test('Groq: the schema is sent as strict json_schema, and a refusal falls back the same way', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.GROQ_API_KEY = 'g'
    const bodies = []
    global.fetch = jest.fn(async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body)
      if (body.response_format && bodies.length === 2) return { ok: false, status: 400, text: async () => '{"error":{"message":"invalid json_schema"}}' }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"verdict":"Avoid"}' }, finish_reason: 'stop' }] }) }
    })
    const r = new AIRouter('t-groq')
    expect(await r.callGroq({ prompt: 'p', schema, schemaName: 'my schema!' })).toMatchObject({ constrained: true, stopReason: 'stop' })
    expect(bodies[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'my_schema_', strict: true, schema } })
    const out = await r.callGroq({ prompt: 'p', schema, schemaName: 'other' })
    expect(out.constrained).toBe(false)
    expect(bodies[2]).not.toHaveProperty('response_format')
    console.warn.mockRestore()
  })
})
