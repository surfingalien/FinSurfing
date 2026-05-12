/**
 * usePortfolio — unified portfolio hook.
 *
 * When authenticated (activePortfolioId + authFetch provided):
 *   → Fetches holdings from GET /api/portfolios/:id
 *   → Mutations (add/remove/update) call the appropriate API endpoints
 *   → localStorage is NOT used (data lives in the server)
 *
 * When guest (no activePortfolioId / not authenticated):
 *   → Falls back to localStorage, namespaced by userId (or 'guest')
 *   → INITIAL_PORTFOLIO = [] so guests start empty
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { INITIAL_PORTFOLIO } from '../data/portfolio'
import { fetchQuotes } from '../services/api'

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

// ── Main hook ─────────────────────────────────────────────────────────────────
export function usePortfolio({ userId, activePortfolioId, authFetch } = {}) {
  const apiMode = !!(activePortfolioId && authFetch)

  // positions: always the raw holdings array (no market data yet)
  const [positions,    setPositions]    = useState(apiMode ? [] : (loadStored(userId) || INITIAL_PORTFOLIO))
  const [quotes,       setQuotes]       = useState({})
  const [loading,      setLoading]      = useState(apiMode)
  const [lastUpdated,  setLastUpdated]  = useState(null)
  const [apiError,     setApiError]     = useState(null)

  // Track the portfolio ID in a ref so callbacks stay stable
  const portIdRef = useRef(activePortfolioId)
  portIdRef.current = activePortfolioId

  // ── API mode: load holdings from server ────────────────────────────────────
  const loadFromApi = useCallback(async () => {
    if (!activePortfolioId || !authFetch) return
    setLoading(true)
    setApiError(null)
    try {
      const res  = await authFetch(`/api/portfolios/${activePortfolioId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const holdings = (data.holdings || []).map(h => ({
        id:        h.id,
        symbol:    h.symbol,
        name:      h.name   || h.symbol,
        shares:    parseFloat(h.shares),
        avgCost:   parseFloat(h.avgCost ?? h.avg_cost_basis ?? 0),
        sector:    h.sector    || null,
        assetClass:h.assetClass|| 'equity',
      }))
      setPositions(holdings)
    } catch (err) {
      setApiError(err.message)
    } finally {
      setLoading(false)
    }
  }, [activePortfolioId, authFetch])

  // Reload whenever the active portfolio changes
  useEffect(() => {
    if (apiMode) {
      loadFromApi()
    } else {
      // Guest mode — restore from localStorage when userId changes
      setPositions(loadStored(userId) || INITIAL_PORTFOLIO)
    }
  }, [activePortfolioId, userId, apiMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Guest mode: persist to localStorage ───────────────────────────────────
  useEffect(() => {
    if (!apiMode) saveStored(userId, positions)
  }, [positions, userId, apiMode])

  // ── Quote refresh (works the same regardless of mode) ─────────────────────
  const refresh = useCallback(async () => {
    if (!positions.length) return
    setLoading(true)
    try {
      const symbols = positions.map(p => p.symbol)
      const results = await fetchQuotes(symbols)
      const map = {}
      results.forEach(q => { if (q.symbol) map[q.symbol] = q })
      setQuotes(map)
      setLastUpdated(new Date())
    } catch (e) {
      console.warn('Quote refresh failed:', e.message)
    } finally {
      setLoading(false)
    }
  }, [positions])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 60000)
    return () => clearInterval(t)
  }, [refresh])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const addPosition = useCallback(async (pos) => {
    if (apiMode) {
      // Upsert via API (POST does insert-or-update by symbol)
      const res = await authFetch(`/api/portfolios/${portIdRef.current}/holdings`, {
        method: 'POST',
        body: {
          symbol:    pos.symbol,
          name:      pos.name,
          shares:    pos.shares,
          avgCost:   pos.avgCost,
          sector:    pos.sector    || null,
          assetClass:pos.assetClass|| 'equity',
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
      // Find the holding ID first
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
      await loadFromApi()
    } else {
      setPositions(prev => prev.filter(p => p.symbol !== symbol))
    }
  }, [apiMode, authFetch, loadFromApi, positions])

  const updatePosition = useCallback(async (symbol, updates) => {
    if (apiMode) {
      const holding = positions.find(p => p.symbol === symbol)
      if (!holding) return
      // Re-upsert with merged values
      const res = await authFetch(`/api/portfolios/${portIdRef.current}/holdings`, {
        method: 'POST',
        body: {
          symbol,
          name:      updates.name      ?? holding.name,
          shares:    updates.shares    ?? holding.shares,
          avgCost:   updates.avgCost   ?? holding.avgCost,
          sector:    updates.sector    ?? holding.sector,
          assetClass:updates.assetClass?? holding.assetClass,
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

    // ── Today's P/L — proper daily reset.
    // Problem: after a session closes, Yahoo keeps regularMarketPrice = that
    // session's close and regularMarketPreviousClose = the prior session's close,
    // so (price − prevClose) equals yesterday's full move, not "today's" move.
    // Fix: check regularMarketTime (Unix seconds). If it's from a previous
    // calendar date, the market hasn't traded today → todayGL = 0.
    const prevClose  = q?.prevClose ?? null
    const marketTime = q?.marketTime ?? null   // Unix seconds
    const isToday    = marketTime
      ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
      : true   // if timestamp missing, trust the change value
    const todayGL    = isToday && price !== null && prevClose !== null
      ? (price - prevClose) * pos.shares
      : isToday && q?.change != null
        ? q.change * pos.shares
        : 0   // prior session data — reset to 0 until today's session begins

    return { ...pos, ...q, price, costBasis, mktValue, gainLoss, gainLossPct, todayGL }
  })

  const totalCost  = enriched.reduce((s, p) => s + p.costBasis, 0)
  const totalValue = enriched.reduce((s, p) => s + (p.mktValue ?? p.costBasis), 0)
  const totalGL    = totalValue - totalCost
  const totalGLPct = totalCost > 0 ? (totalGL / totalCost) * 100 : 0
  const todayTotal = enriched.reduce((s, p) => s + (p.todayGL ?? 0), 0)

  return {
    positions: enriched,
    quotes,
    loading,
    lastUpdated,
    apiError,
    refresh:        apiMode ? loadFromApi : refresh,
    addPosition,
    removePosition,
    updatePosition,
    summary: { totalCost, totalValue, totalGL, totalGLPct, todayTotal },
  }
}
