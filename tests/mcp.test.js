'use strict'
/**
 * End-to-end tests for routes/mcp.js using the official MCP TypeScript SDK
 * client over streamable HTTP against the test app on an ephemeral port.
 * Exercises: auth gating, initialize handshake, tools/list parity with the
 * copilot registry, and tools/call for the in-process tools (no network).
 */

const http = require('http')
const jwt  = require('jsonwebtoken')
const { createApp } = require('./helpers/app')           // sets JWT_SECRET for tests
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { TOOLS } = require('../routes/copilot')
const symbolDb = require('../lib/symbol-db')

let server, baseUrl, token

beforeAll(async () => {
  const app = createApp()
  server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
  token = jwt.sign(
    { sub: 'test-user', email: 'mcp@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' },
  )
  // Deterministic symbol catalog for classify_symbol / sector_universe
  symbolDb._setStoreForTests({
    fetchedAt: '2026-06-11T00:00:00Z',
    classes: {
      equity: [
        { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Information Technology', industry: 'Technology Hardware', country: 'United States', marketCap: 'Mega Cap' },
        { symbol: 'NVDA', name: 'Nvidia Corp', sector: 'Information Technology', industry: 'Semiconductors', country: 'United States', marketCap: 'Mega Cap' },
      ],
      etf:    [{ symbol: 'SPY', name: 'SPDR S&P 500 ETF', categoryGroup: 'Equities', category: 'Large Blend', family: 'SPDR' }],
      fund:   [],
      crypto: [{ symbol: 'BTC-USD', name: 'Bitcoin USD', base: 'BTC' }],
    },
  })
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

function makeClient() {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'finsurfing-test-client', version: '1.0.0' })
  return { client, transport }
}

describe('MCP_API_KEY static auth (opt-in)', () => {
  const post = (token) => fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  })

  afterEach(() => { delete process.env.MCP_API_KEY })

  test('matching static key is accepted', async () => {
    process.env.MCP_API_KEY = 'static-test-key-123'
    const res = await post('static-test-key-123')
    expect(res.status).toBe(200)
  })

  test('wrong static key falls through to JWT auth and fails', async () => {
    process.env.MCP_API_KEY = 'static-test-key-123'
    const res = await post('wrong-key')
    expect(res.status).toBe(401)
  })

  test('a valid JWT still works when MCP_API_KEY is set', async () => {
    process.env.MCP_API_KEY = 'static-test-key-123'
    const res = await post(token)
    expect(res.status).toBe(200)
  })

  test('static keys are rejected when MCP_API_KEY is unset', async () => {
    const res = await post('static-test-key-123')
    expect(res.status).toBe(401)
  })
})

describe('auth gating', () => {
  test('POST without a token is rejected with 401', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    expect(res.status).toBe(401)
  })

  test('GET is 405 (stateless endpoint)', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(405)
  })
})

describe('MCP protocol', () => {
  test('initialize handshake reports the finsurfing server', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    expect(client.getServerVersion()).toMatchObject({ name: 'finsurfing' })
    await transport.close()
  })

  test('tools/list mirrors the copilot registry', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(TOOLS.map(t => t.name).sort())
    const classify = tools.find(t => t.name === 'classify_symbol')
    expect(classify.inputSchema).toMatchObject({ type: 'object', required: ['symbol'] })
    await transport.close()
  })

  test('tools/call classify_symbol returns catalog metadata', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    const res = await client.callTool({ name: 'classify_symbol', arguments: { symbol: 'aapl' } })
    expect(res.content[0].text).toContain('Apple Inc.')
    expect(res.content[0].text).toContain('Information Technology')
    await transport.close()
  })

  test('tools/call sector_universe lists sector symbols', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    const res = await client.callTool({ name: 'sector_universe', arguments: { sector: 'Information Technology' } })
    expect(res.content[0].text).toContain('AAPL')
    expect(res.content[0].text).toContain('NVDA')
    await transport.close()
  })

  test('tools/call get_calibration handles an empty prediction log', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    const res = await client.callTool({ name: 'get_calibration', arguments: {} })
    expect(typeof res.content[0].text).toBe('string')
    expect(res.content[0].text.length).toBeGreaterThan(10)
    await transport.close()
  })

  test('tools/call unknown tool returns isError', async () => {
    const { client, transport } = makeClient()
    await client.connect(transport)
    const res = await client.callTool({ name: 'not_a_tool', arguments: {} })
    expect(res.isError).toBe(true)
    await transport.close()
  })
})
