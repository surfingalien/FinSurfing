const express = require('express')
const router = express.Router()

const FMP_BASE = 'https://financialmodelingprep.com/api/v3'

function getFmpKey(req) {
  return req.headers['x-fmp-key'] || process.env.FMP_API_KEY || ''
}

function formatFlowSnippet(flow) {
  const { pcRatio, atmIv, unusualActivity, callVolume, putVolume } = flow
  const bias = pcRatio < 0.7 ? 'bullish' : pcRatio > 1.3 ? 'bearish' : 'neutral'
  const unusualStr = unusualActivity?.length
    ? ` Unusual: ${unusualActivity.map(u => `${u.strike}${u.side}(${u.ratio.toFixed(1)}x)`).join(', ')}.`
    : ''
  return `P/C ratio ${pcRatio?.toFixed(2) ?? 'n/a'} (${bias}), ATM IV ${atmIv != null ? (atmIv * 100).toFixed(1) + '%' : 'n/a'}, calls ${callVolume ?? 0} vs puts ${putVolume ?? 0}.${unusualStr}`
}

router.get('/flow', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const fmpKey = getFmpKey(req)
  if (!fmpKey) {
    return res.json({ symbol, pcRatio: null, atmIv: null, unusualActivity: [], snippet: 'Options data unavailable (no FMP key).' })
  }

  try {
    const url = `${FMP_BASE}/options/chain/${symbol.toUpperCase()}?apikey=${fmpKey}`
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`FMP ${r.status}`)
    const data = await r.json()

    const chain = Array.isArray(data) ? data : (data?.optionChain ?? [])
    if (!chain.length) throw new Error('empty chain')

    let callVolume = 0, putVolume = 0
    let callOI = 0, putOI = 0
    const unusualActivity = []

    // Find approximate ATM price from the chain mid-strikes
    const strikes = [...new Set(chain.map(o => o.strike))].sort((a, b) => a - b)
    const midStrike = strikes[Math.floor(strikes.length / 2)]

    let atmCallIv = null, atmPutIv = null

    for (const opt of chain) {
      const vol = opt.volume ?? 0
      const oi = opt.openInterest ?? 0
      const isCall = (opt.type || opt.optionType || '').toLowerCase().includes('call')

      if (isCall) { callVolume += vol; callOI += oi }
      else { putVolume += vol; putOI += oi }

      // ATM IV
      if (opt.strike === midStrike) {
        const iv = opt.impliedVolatility ?? opt.iv
        if (iv) {
          if (isCall) atmCallIv = iv
          else atmPutIv = iv
        }
      }

      // Unusual: vol > 3× OI
      if (oi > 0 && vol > 3 * oi && vol > 100) {
        unusualActivity.push({ strike: opt.strike, side: isCall ? 'C' : 'P', ratio: vol / oi })
      }
    }

    const pcRatio = callVolume > 0 ? putVolume / callVolume : null
    const atmIv = atmCallIv ?? atmPutIv

    const flow = { symbol: symbol.toUpperCase(), pcRatio, atmIv, callVolume, putVolume, callOI, putOI, unusualActivity: unusualActivity.slice(0, 5) }
    flow.snippet = formatFlowSnippet(flow)
    res.json(flow)
  } catch (err) {
    res.json({ symbol: symbol.toUpperCase(), pcRatio: null, atmIv: null, unusualActivity: [], snippet: `Options flow unavailable: ${err.message}` })
  }
})

module.exports = router
