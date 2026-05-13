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
 * Streams Claude's rebalancing plan via SSE — powered by AWS Bedrock.
 */

const express             = require('express')
const { requireAuth }     = require('../middleware/auth')
const { getBedrockClient } = require('../utils/bedrockClient')

const router = express.Router()
router.use(requireAuth)

const DEFAULT_MODEL = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'

router.post('/suggest', async (req, res) => {
  const { holdings = [], targetAllocation = {}, riskProfile = 'moderate' } = req.body

  if (!Array.isArray(holdings) || holdings.length === 0)
    return res.status(400).json({ error: 'holdings array is required' })

  // Compute current portfolio value + sector weights
  const totalValue = holdings.reduce((s, h) => s + (h.shares * h.currentPrice || 0), 0)
  if (totalValue <= 0)
    return res.status(400).json({ error: 'Portfolio value is zero — provide currentPrice for holdings' })

  const sectorMap = {}
  for (const h of holdings) {
    const sec = h.sector || 'Unknown'
    const val = (h.shares || 0) * (h.currentPrice || 0)
    sectorMap[sec] = (sectorMap[sec] || 0) + val
  }
  const currentAlloc = Object.fromEntries(
    Object.entries(sectorMap).map(([s, v]) => [s, +((v / totalValue) * 100).toFixed(1)])
  )

  const holdingLines = holdings.map(h => {
    const val = (h.shares * h.currentPrice).toFixed(2)
    const pct = ((h.shares * h.currentPrice / totalValue) * 100).toFixed(1)
    return `  - ${h.symbol}: ${h.shares} shares @ $${h.currentPrice} = $${val} (${pct}%)`
  }).join('\n')

  const allocLines = Object.entries(currentAlloc)
    .map(([s, w]) => `  - ${s}: ${w}% current → ${targetAllocation[s] ?? '?'}% target`)
    .join('\n')

  const prompt = `You are a professional portfolio manager. Analyze this portfolio and create a specific rebalancing plan.

**Portfolio** (total value: $${totalValue.toFixed(2)})
${holdingLines}

**Sector Allocation Analysis**
${allocLines}

**Risk Profile**: ${riskProfile}

Provide a structured rebalancing plan:

1. **Executive Summary** — 2-3 sentences on the key imbalances and overall recommendation.

2. **Rebalancing Actions** — Specific buy/sell/trim/add actions per holding. Be concrete (e.g. "Sell 15 shares of MSFT (~$6,200) to reduce Technology overweight").

3. **Priority Order** — Rank the top 5 trades by impact, with the tax/cost rationale.

4. **After Rebalance** — Project the new sector weights and explain how they align with the ${riskProfile} profile.

5. **Risks & Considerations** — Tax impact (short vs long-term), transaction costs, partial rebalancing if full rebalance is disruptive.

Be direct and actionable. Use dollar amounts, share counts, and percentages throughout.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  try {
    const { ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime')
    const client  = getBedrockClient()
    const command = new ConverseStreamCommand({
      modelId:         DEFAULT_MODEL,
      messages:        [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1500, temperature: 0.7 },
    })

    const response = await client.send(command)
    for await (const event of response.stream) {
      const text = event.contentBlockDelta?.delta?.text
      if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`)
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
