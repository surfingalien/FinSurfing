'use strict'
/**
 * lib/alt-data.js
 *
 * Phase 1 alternative data — free public sources only.
 *
 * getInsiderActivity(symbol) — SEC EDGAR Form 4 (free, no auth)
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
  } catch (e) {
    return null
  } finally {
    clearTimeout(tid)
  }
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ── SEC EDGAR Form 4 — insider transactions ───────────────────────────────────

async function getInsiderActivity(symbol) {
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(symbol)}%22&dateRange=custom&startdt=${daysAgo(90)}&forms=4&hits.hits.total.value=1&hits.hits._source=period_of_report,entity_name,file_date`
    const raw = await safeFetch(url)
    const hits = raw?.hits?.hits || []
    if (!hits.length) return null

    return hits.slice(0, 8).map(h => {
      const s = h._source || {}
      return {
        date:   s.file_date || s.period_of_report || '?',
        filer:  s.entity_name || 'Unknown',
        form:   '4',
      }
    })
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
    lines.push(`\nINSIDER ACTIVITY (SEC Form 4, last 90 days) for ${symbol}:`)
    for (const t of insider) {
      lines.push(`  • ${t.date} — ${t.filer} filed Form 4`)
    }
    lines.push(`  Total filings: ${insider.length}`)
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
