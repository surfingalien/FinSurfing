'use strict'
/**
 * lib/alt-data.js
 *
 * Phase 1 alternative data — free public sources only.
 *
 * getInsiderActivity(symbol) — OpenInsider (buy/sell direction, shares, price)
 * getShortInterest(symbol)   — FINRA short interest (free, no auth)
 * getAltDataSnippet(symbol)  — Combined prompt-injection string
 */

const TIMEOUT = 8_000

async function safeFetch(url) {
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(tid)
  }
}

// ── OpenInsider — insider buy/sell with direction, shares, price ──────────────

async function getInsiderActivity(symbol) {
  try {
    const clean = symbol.replace(/-USD$/, '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
    const url = `https://openinsider.com/screener?s=${clean}&fd=-1&td=0&tdr=&fdlyl=&fdlyh=&daysago=90&xp=1&xs=1&cnt=10&action=getdata`
    const ctrl = new AbortController()
    const tid  = setTimeout(() => ctrl.abort(), TIMEOUT)
    let html
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinSurfing/2.0)' },
        signal: ctrl.signal,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      html = await r.text()
    } finally {
      clearTimeout(tid)
    }

    // Parse tbody rows — each <tr> is one transaction
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)
    if (!tbodyMatch) return null
    const rows = [...tbodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    if (!rows.length) return null

    const transactions = []
    for (const row of rows) {
      // Strip all tags from each <td>, get text values
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#[0-9]+;/g, '').trim())
      // Expected column order: X, filing-date, trade-date, ticker, company, insider, title, trade-type, price, qty, ...
      if (cells.length < 9) continue
      const tradeType = cells[7]
      const isBuy  = /^P\b/.test(tradeType)
      const isSell = /^S\b/.test(tradeType)
      if (!isBuy && !isSell) continue
      const qtyRaw = cells[9]?.replace(/[^0-9+-]/g, '')
      transactions.push({
        date:  cells[2] || cells[1] || '?',
        name:  cells[5] || 'Unknown',
        title: cells[6] || '',
        type:  isBuy ? 'BUY' : 'SELL',
        price: cells[8] || null,
        qty:   qtyRaw ? Math.abs(parseInt(qtyRaw, 10)) : null,
      })
    }

    return transactions.length ? transactions : null
  } catch {
    return null
  }
}

// ── FINRA — short interest ────────────────────────────────────────────────────

async function getShortInterest(symbol) {
  try {
    const url = `https://api.finra.org/data/group/otcMarket/name/weeklySummary?limit=2&compareFilters=[{"compareType":"EQUAL","fieldName":"issueSymbolIdentifier","fieldValue":"${symbol}"}]`
    const data = await safeFetch(url)
    if (!Array.isArray(data) || !data.length) return null

    return data.map(d => ({
      week:        d.weekStartDate,
      shortVolume: d.totalShortParQuantity,
      totalVolume: d.totalParQuantity,
      shortRatio:  d.totalParQuantity
        ? +(d.totalShortParQuantity / d.totalParQuantity * 100).toFixed(1)
        : null,
    }))
  } catch {
    return null
  }
}

// ── Combined snippet for LLM prompt injection ─────────────────────────────────

async function getAltDataSnippet(symbol) {
  const [insider, short] = await Promise.all([
    getInsiderActivity(symbol),
    getShortInterest(symbol),
  ])

  const lines = []

  if (insider?.length) {
    const buys  = insider.filter(t => t.type === 'BUY')
    const sells = insider.filter(t => t.type === 'SELL')
    const signal = buys.length > sells.length ? '🟢 net buying' : sells.length > buys.length ? '🔴 net selling' : '⚪ mixed'
    lines.push(`\nINSIDER ACTIVITY (OpenInsider, last 90d) for ${symbol}: ${signal} (${buys.length} buys, ${sells.length} sells)`)
    for (const t of insider.slice(0, 4)) {
      const vol = t.qty ? ` · ${t.qty.toLocaleString()} shares` : ''
      const px  = t.price ? ` @ ${t.price}` : ''
      const title = t.title ? ` (${t.title})` : ''
      lines.push(`  • ${t.date} — ${t.name}${title}: ${t.type}${vol}${px}`)
    }
  }

  if (short?.length) {
    const latest = short[0]
    lines.push(`\nSHORT INTEREST (FINRA) for ${symbol}:`)
    lines.push(`  • Week of ${latest.week}: short ratio ${latest.shortRatio ?? 'N/A'}% (${latest.shortVolume?.toLocaleString()} short / ${latest.totalVolume?.toLocaleString()} total)`)
    if (short[1]) {
      const prev = short[1]
      const delta = latest.shortRatio != null && prev.shortRatio != null
        ? (latest.shortRatio - prev.shortRatio).toFixed(1)
        : null
      if (delta !== null) lines.push(`  • Prior week: ${prev.shortRatio}% (change: ${delta > 0 ? '+' : ''}${delta}pp)`)
    }
  }

  return lines.length ? lines.join('\n') : null
}

module.exports = { getInsiderActivity, getShortInterest, getAltDataSnippet }
