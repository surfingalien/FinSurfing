/**
 * usePortfolio — unified portfolio hook.
 *
 * When authenticated (activePortfolioId + authFetch provided):
 *   → Fetches holdings from GET /api/portfolios/:id
 *   → Mutations (add/remove/update) call the appropriate API endpoints
 *   → localStorage is used as a backup so holdings survive server restarts
 *     (Railway ephemeral memory resets on every deploy)
 *
 * When guest (no activePortfolioId / not authenticated):
 *   → Falls back to localStorage, namespaced by userId (or 'guest')
 *   → INITIAL_PORTFOLIO = [] so guests start empty
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { INITIAL_PORTFOLIO } from '../data/portfolio'
import { fetchQuotes, subscribeQuotes } from '../services/api'

// ── Guest localStorage helpers ────────────────────────────────────────────────
const DATA_VERSION = '3'

function lsKey(userId)     { return `finsurf_portfolio_${userId || 'guest'}` }
function lsVerKey(userId)  { return `finsurf_portfolio_v_${userId || 'guest'}` }

function loadStored(userId) {
  try {
    const vKey = lsVerKey(userId)
    const dKey = lsKey(userId)
    if (localStorage.getItem(vKey) !== DATA_VERSION) {
      localStorage.removeItem(dKey)
      localStorage.setItem(vKey, DATA_VERSION)
      return null
    }
    const raw = localStorage.getItem(dKey)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveStored(userId, positions) {
  try { localStorage.setItem(lsKey(userId), JSON.stringify(positions)) } catch {}
}

// ── Last-known quotes (survive provider outages + server cache wipes) ─────────
// When a refresh comes back without a symbol (provider failure, rate limit,
// empty server cache after a deploy), we fall back to the last real price,
// marked stale, instead of silently counting the position at cost basis —
// which made Total P&L understate losses.
const LAST_QUOTES_KEY = 'finsurf_last_quotes'

function loadLastQuotes() {
  try { return JSON.parse(localStorage.getItem(LAST_QUOTES_KEY)) || {} } catch { return {} }
}

function saveLastQuotes(freshQuotes) {
  try {
    const stored = loadLastQuotes()
    for (const q of freshQuotes) {
      if (!q.symbol || q.price == null) continue
      stored[q.symbol] = {
        symbol: q.symbol, name: q.name, price: q.price,
        prevClose: q.prevClose ?? null, marketTime: q.marketTime ?? null,
        change: q.change ?? null, changePct: q.changePct ?? null,
        savedAt: Date.now(),
      }
    }
    localStorage.setItem(LAST_QUOTES_KEY, JSON.stringify(stored))
  } catch {}
}

// ── API mode: localStorage backup (survives Railway server restarts) ───────────
function apiLsKey(pid) { return `finsurf_api_holdings_${pid}` }

function loadApiBackup(pid) {
  try { const r = localStorage.getItem(apiLsKey(pid)); return r ? JSON.parse(r) : null } catch { return null }
}

function saveApiBackup(pid, holdings) {
  try { localStorage.setItem(apiLsKey(pid), JSON.stringify(holdings)) } catch {}
}

// ── Main hook ─────────────────────────────────────────────────────────────────
export function usePortfolio({ userId, activePortfolioId, authFetch } = {}) {
  const apiMode = !!(activePortfolioId && authFetch)

  const [positions,    setPositions]    = useState(apiMode ? [] : (loadStored(userId) || INITIAL_PORTFOLIO))
  const [quotes,       setQuotes]       = useState({})
  const [loading,      setLoading]      = useState(apiMode)
  const [lastUpdated,  setLastUpdated]  = useState(null)
  const [apiError,     setApiError]     = useState(null)

  const portIdRef = useRef(activePortfolioId)
  portIdRef.current = activePortfolioId

  // ── API mode: load holdings from server, restore from localStorage if empty ──
  const loadFromApi = useCallback(async () => {
    if (!activePortfolioId || !authFetch) return
    setLoading(true)
    setApiError(null)
    try {
      const res  = await authFetch(`/api/portfolios/${activePortfolioId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      let holdings = (data.holdings || []).map(h => ({
        id:         h.id,
        symbol:     h.symbol,
        name:       h.name   || h.symbol,
        shares:     parseFloat(h.shares),
        avgCost:    parseFloat(h.avgCost ?? h.avg_cost_basis ?? 0),
        sector:     h.sector     || null,
        assetClass: h.assetClass || 'equity',
      }))

      // Server returned empty — restore from localStorage backup (e.g. after Railway restart)
      if (holdings.length === 0) {
        const backup = loadApiBackup(activePortfolioId)
        if (backup?.length) {
          console.log(`[portfolio] Server empty — restoring ${backup.length} holdings from localStorage backup`)
          for (const h of backup) {
            try {
              await authFetch(`/api/portfolios/${activePortfolioId}/holdings`, {
                method: 'POST',
                body: {
                  symbol:     h.symbol,
                  name:       h.name,
                  shares:     h.shares,
                  avgCost:    h.avgCost,
                  sector:     h.sector     || null,
                  assetClass: h.assetClass || 'equity',
                },
              })
            } catch { /* best effort */ }
          }
          // Re-fetch to get server-assigned IDs
          const res2 = await authFetch(`/api/portfolios/${activePortfolioId}`)
          if (res2.ok) {
            const data2 = await res2.json()
            holdings = (data2.holdings || []).map(h => ({
              id:         h.id,
              symbol:     h.symbol,
              name:       h.name   || h.symbol,
              shares:     parseFloat(h.shares),
              avgCost:    parseFloat(h.avgCost ?? h.avg_cost_basis ?? 0),
              sector:     h.sector     || null,
              assetClass: h.assetClass || 'equity',
            }))
          }
        }
      }

      // Always keep localStorage in sync with whatever the server has
      if (holdings.length > 0) saveApiBackup(activePortfolioId, holdings)

      setPositions(holdings)
    } catch (err) {
      setApiError(err.message)
    } finally {
      setLoading(false)
    }
  }, [activePortfolioId, authFetch])

  useEffect(() => {
    if (apiMode) {
      loadFromApi()
    } else {
      setPositions(loadStored(userId) || INITIAL_PORTFOLIO)
    }
  }, [activePortfolioId, userId, apiMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Guest mode: persist to localStorage ───────────────────────────────────
  useEffect(() => {
    if (!apiMode) saveStored(userId, positions)
  }, [positions, userId, apiMode])

  // ── Quote refresh ──────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!positions.length) return
    setLoading(true)
    try {
      const symbols = positions.map(p => p.symbol)
      const results = await fetchQuotes(symbols, { force: true })
      const map = {}
      results.forEach(q => { if (q.symbol && q.price != null) map[q.symbol] = q })
      saveLastQuotes(results)
      // Symbols the providers failed to price: fall back to last known quote
      const stored = loadLastQuotes()
      for (const sym of symbols) {
        if (!map[sym] && stored[sym]) map[sym] = { ...stored[sym], stale: true }
      }
      setQuotes(map)
      setLastUpdated(new Date())
    } catch (e) {
      console.warn('Quote refresh failed:', e.message)
    } finally {
      setLoading(false)
    }
  }, [positions])

  useEffect(() => {
    if (!positions.length) return
    refresh()
    const fullRefresh = setInterval(refresh, 30_000)

    const symbols = positions.map(p => p.symbol)
    const unsub = subscribeQuotes(symbols, ({ symbol, price, change, changePct, ts }) => {
      setQuotes(prev => {
        const existing = prev[symbol] || {}
        return {
          ...prev,
          [symbol]: {
            ...existing,
            price,
            // Never overwrite a valid change/changePct with null from a WS tick that
            // arrived before prevClose was populated in the server cache.
            change:    change    ?? existing.change,
            changePct: changePct ?? existing.changePct,
            marketTime: ts ? Math.floor(ts / 1000) : existing.marketTime,
            stale: false,   // a live tick supersedes any last-known fallback
          },
        }
      })
      setLastUpdated(new Date())
    })

    // Refresh immediately when the user returns to the tab
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(fullRefresh)
      unsub()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ──────────────────────────────────────────────────────────────

  const addPosition = useCallback(async (pos) => {
    if (apiMode) {
      const res = await authFetch(`/api/portfolios/${portIdRef.current}/holdings`, {
        method: 'POST',
        body: {
          symbol:     pos.symbol,
          name:       pos.name,
          shares:     pos.shares,
          avgCost:    pos.avgCost,
          sector:     pos.sector     || null,
          assetClass: pos.assetClass || 'equity',
        },
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save holding')
      }
      await loadFromApi()
    } else {
      setPositions(prev => {
        const idx = prev.findIndex(p => p.symbol === pos.symbol)
        if (idx >= 0) {
          const updated = [...prev]
          const old = updated[idx]
          const totalShares = old.shares + pos.shares
          const newAvg = (old.shares * old.avgCost + pos.shares * pos.avgCost) / totalShares
          updated[idx] = { ...old, shares: totalShares, avgCost: +newAvg.toFixed(4) }
          return updated
        }
        return [...prev, pos]
      })
    }
  }, [apiMode, authFetch, loadFromApi])

  const removePosition = useCallback(async (symbol) => {
    if (apiMode) {
      const holding = positions.find(p => p.symbol === symbol)
      if (!holding?.id) { await loadFromApi(); return }
      const res = await authFetch(
        `/api/portfolios/${portIdRef.current}/holdings/${holding.id}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to remove holding')
      }
      // Remove from localStorage backup immediately
      const backup = loadApiBackup(portIdRef.current) || []
      saveApiBackup(portIdRef.current, backup.filter(h => h.symbol !== symbol))
      await loadFromApi()
    } else {
      setPositions(prev => prev.filter(p => p.symbol !== symbol))
    }
  }, [apiMode, authFetch, loadFromApi, positions])

  const updatePosition = useCallback(async (symbol, updates) => {
    if (apiMode) {
      const holding = positions.find(p => p.symbol === symbol)
      if (!holding) return
      const res = await authFetch(`/api/portfolios/${portIdRef.current}/holdings`, {
        method: 'POST',
        body: {
          symbol,
          name:       updates.name       ?? holding.name,
          shares:     updates.shares     ?? holding.shares,
          avgCost:    updates.avgCost    ?? holding.avgCost,
          sector:     updates.sector     ?? holding.sector,
          assetClass: updates.assetClass ?? holding.assetClass,
        },
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to update holding')
      }
      await loadFromApi()
    } else {
      setPositions(prev => prev.map(p => p.symbol === symbol ? { ...p, ...updates } : p))
    }
  }, [apiMode, authFetch, loadFromApi, positions])

  // ── Enrich positions with live market data ────────────────────────────────
  const enriched = positions.map(pos => {
    const q          = quotes[pos.symbol]
    const price      = q?.price ?? null
    const costBasis  = pos.shares * pos.avgCost
    const mktValue   = price !== null ? price * pos.shares : null
    const gainLoss   = mktValue !== null ? mktValue - costBasis : null
    const gainLossPct= gainLoss !== null && costBasis > 0 ? (gainLoss / costBasis) * 100 : null

    const prevClose  = q?.prevClose ?? null
    const marketTime = q?.marketTime ?? null
    // No timestamp → treat as stale so daily P&L resets at midnight
    const isToday    = marketTime
      ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
      : false
    const todayGL    = isToday && price !== null && prevClose !== null
      ? (price - prevClose) * pos.shares
      : isToday && q?.change != null
        ? q.change * pos.shares
        : 0

    return { ...pos, ...q, price, costBasis, mktValue, gainLoss, gainLossPct, todayGL }
  })

  const totalCost  = enriched.reduce((s, p) => s + p.costBasis, 0)
  // Positions with no price at all (not even a last-known fallback) are
  // counted at cost — i.e. shown as break-even. unpricedCount exposes how
  // many holdings that affects so the UI can flag an incomplete P&L.
  const totalValue = enriched.reduce((s, p) => s + (p.mktValue ?? p.costBasis), 0)
  const totalGL    = totalValue - totalCost
  const totalGLPct = totalCost > 0 ? (totalGL / totalCost) * 100 : 0
  const todayTotal = enriched.reduce((s, p) => s + (p.todayGL ?? 0), 0)
  const totalCount   = enriched.length
  const staleCount   = enriched.filter(p => p.price !== null && p.stale).length
  const unpricedCount= enriched.filter(p => p.price === null).length
  const pricedCount  = totalCount - staleCount - unpricedCount

  return {
    positions: enriched,
    quotes,
    loading,
    lastUpdated,
    apiError,
    refresh:        refresh,
    addPosition,
    removePosition,
    updatePosition,
    summary: { totalCost, totalValue, totalGL, totalGLPct, todayTotal, totalCount, pricedCount, staleCount, unpricedCount },
  }
}
