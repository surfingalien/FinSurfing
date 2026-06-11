'use strict'
/**
 * routes/mcp.js
 *
 * POST /api/mcp — Model Context Protocol endpoint (streamable HTTP, stateless)
 *
 * Exposes the copilot tool registry (routes/copilot.js TOOLS + dispatchTool)
 * to any MCP client — Claude Desktop, Claude Code, IDEs, agents — so
 * FinSurfing can serve as an analysis backend: market scans, per-symbol
 * analysis, sentiment, macro regime, earnings/options catalysts, symbol
 * classification, portfolio risk, and AI Brain calibration.
 *
 * Stateless mode: a fresh Server + transport per request (no sessions, no
 * resumability, no server-push). JSON responses enabled so plain HTTP
 * clients work without SSE parsing. Auth: same JWT Bearer scheme as the
 * rest of the API (requireAuth); the token is forwarded to internal tool
 * calls so authed tools (portfolio_risk) see the caller's portfolio.
 *
 * Client config example (Claude Code):
 *   claude mcp add --transport http finsurfing https://<host>/api/mcp \
 *     --header "Authorization: Bearer <token>"
 */

const express = require('express')
const crypto  = require('crypto')
const { requireAuth } = require('../middleware/auth')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const { TOOLS, dispatchTool } = require('./copilot')

const router = express.Router()

// Fresh server per request — `req` is captured so dispatchTool can forward
// the caller's auth + API-key headers to internal loopback routes.
function buildServer(req) {
  const server = new Server(
    { name: 'finsurfing', version: '2.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    if (!TOOLS.some(t => t.name === name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
    try {
      const result = await dispatchTool(name, args || {}, req)
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Tool ${name} failed: ${err.message}` }], isError: true }
    }
  })

  return server
}

// MCP clients are long-lived; JWT access tokens are not. When the operator
// sets MCP_API_KEY, that static key is accepted as the Bearer token
// (constant-time compare); otherwise — and for any non-matching token —
// normal JWT auth applies unchanged. Opt-in only.
function mcpAuth(req, res, next) {
  const configured = process.env.MCP_API_KEY
  const header = req.headers.authorization || ''
  if (configured && header.startsWith('Bearer ')) {
    const given = Buffer.from(header.slice(7))
    const want  = Buffer.from(configured)
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
      req.user = { userId: 'mcp-api-key', email: null, role: 'user' }
      return next()
    }
  }
  return requireAuth(req, res, next)
}

router.post('/', mcpAuth, async (req, res) => {
  try {
    const server    = buildServer(req)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
      enableJsonResponse: true,        // plain JSON instead of SSE
    })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('[mcp]', err.message)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})

// Stateless endpoint: no SSE stream to resume, no session to delete
const methodNotAllowed = (req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed — stateless MCP endpoint, POST only' },
  id: null,
})
router.get('/', methodNotAllowed)
router.delete('/', methodNotAllowed)

module.exports = router
