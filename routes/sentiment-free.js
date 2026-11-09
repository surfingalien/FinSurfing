'use strict'
/**
 * routes/sentiment-free.js — GET /api/sentiment/free?symbols=AAPL,TSLA
 *
 * Keyless sentiment for the Sentiment page: StockTwits self-tagged messages,
 * Reddit mention counts (ApeWisdom) and Google News distinct stories, each
 * reported separately (lib/free-sentiment.js). Public like the other market
 * data; mounted before /api/sentiment, whose router requires a sign-in.
 */
const express = require('express')
const router  = express.Router()

router.get('/', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9.\-]{1,12}$/.test(s)).slice(0, 15)
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' })
  try {
    const results = await require('../lib/free-sentiment').sentimentFor(symbols)
    res.json({ results, sources: ['StockTwits', 'ApeWisdom (Reddit mentions)', 'Google News'], updatedAt: Date.now() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
