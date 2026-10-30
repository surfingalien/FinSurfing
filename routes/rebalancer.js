'use strict'
/**
 * routes/rebalancer.js
 *
 * POST /api/rebalancer/suggest
 * body: { holdings, targetAllocation, riskProfile }
 *   holdings         — [{ symbol, shares, currentPrice, sector }]
 *   targetAllocation — { 'Technology': 30, 'Healthcare': 20, ... } (% by sector)
 *   riskProfile      — 'conservative' | 'moderate' | 'aggressive'
 *
 * Streams Claude's rebalancing plan via SSE.
 */

const express         = require('express')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

const { claudePaused, pausedError } = require('../lib/ai-pause')
const { planRebalance } = require('../lib/rebalance-plan')
let _client = null
function getClient() {
  if (claudePaused()) throw pausedError()
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')
  const Anthropic = require('@anthropic-ai/sdk')
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Prices the server fetched itself; the client's price is used only for a
// holding the server could not price, and the plan says so.
async function serverPrices(symbols) {
  if (!symbols.length) return new Map()
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(`http://127.0.0.1:${port}/api/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(10_000) })
    const rows = (await r.json())?.quoteResponse?.result || []
    return new Map(rows.filter(q => q?.regularMarketPrice > 0).map(q => [String(q.symbol).toUpperCase(), q.regularMarketPrice]))
  } catch { return new Map() }
}

router.post('/suggest', async (req, res) => {
  const { holdings = [], targetAllocation = {}, riskProfile = 'moderate' } = req.body

  if (!Array.isArray(holdings) || holdings.length === 0)
    return res.status(400).json({ error: 'holdings array is required' })

  // The arithmetic is done here, in code (lib/rebalance-plan.js): the model
  // used to work out share counts, dollar amounts and the new weights itself.
  const live = await serverPrices(holdings.map(h => String(h.symbol || '').toUpperCase()).filter(Boolean).slice(0, 100))
  const priced = holdings.map(h => {
    const sym = String(h.symbol || '').toUpperCase()
    const priceSource = live.has(sym) ? 'live' : Number(h.currentPrice) > 0 ? 'page' : Number(h.avgCost) > 0 ? 'cost' : null
    const px = { live: live.get(sym), page: Number(h.currentPrice), cost: Number(h.avgCost) }[priceSource] ?? null
    return { symbol: sym, shares: Number(h.shares) || 0, price: px, sector: h.sector || 'Unknown', priceSource }
  })
  const plan = planRebalance({ holdings: priced, targetAllocation })
  if (!(plan.total > 0))
    return res.status(400).json({ error: 'Portfolio value is zero — no holding has a price' })
  const atCost = priced.filter(h => h.priceSource === 'cost').map(h => h.symbol)
  if (atCost.length) plan.notes.push(`No market price for ${atCost.join(', ')} — valued at your average cost, which may be far from today's price.`)

  const tradeLines = plan.trades.length
    ? plan.trades.map(t => `  - ${t.side.toUpperCase()} ${t.shares} ${t.symbol} (${t.sector}) @ $${t.price} = $${t.value.toFixed(2)}`).join('\n')
    : '  (none — every sector is already within a share of its target)'
  const sectorLines = plan.sectors.map(s => `  - ${s.sector}: ${s.currentPct}% now → ${s.targetPct}% target → ${s.afterPct}% after these trades`).join('\n')

  const prompt = `You are a professional portfolio manager. The rebalancing trades below were COMPUTED IN CODE from the user's holdings and target weights. Use these numbers exactly: do not recompute them, change share counts, or add trades that are not listed.

**Portfolio value**: $${plan.total.toFixed(2)}
**Risk profile**: ${riskProfile}

**Sector weights** (largest drift first)
${sectorLines}

**Trades** (sales fund the buys; cash left over: $${plan.cashResidual.toFixed(2)})
${tradeLines}
${plan.notes.length ? `\n**Notes**\n${plan.notes.map(n => `  - ${n}`).join('\n')}\n` : ''}
Write:

1. **Executive Summary** — 2-3 sentences on the key imbalances and what the trades fix.

2. **Priority Order** — the order to place these trades and why (largest drift and risk reduction first; sells before buys so the cash exists).

3. **Fit With the ${riskProfile} Profile** — whether the after-trade weights suit it, and any concentration that remains.

4. **Risks & Considerations** — transaction costs, partial rebalancing if the full set is disruptive. Tax: purchase dates and cost basis were not provided, so say the tax impact cannot be judged here and what to check before selling.

Keep figures to the ones listed above.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // The computed plan first, so the page can show the trades as a table.
  res.write(`data: ${JSON.stringify({ plan })}\n\n`)

  try {
    const client = getClient()

    // Use messages.create({ stream: true }) — returns a proper async iterable.
    // Do NOT await messages.stream() — its .then() resolves to the final message,
    // leaving nothing to iterate.
    const stream = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 1500,
      stream:     true,
      messages:   [{ role: 'user', content: prompt }],
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
      }
    }

    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    console.error('[rebalancer]', err.message)
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
  }
})

module.exports = router
