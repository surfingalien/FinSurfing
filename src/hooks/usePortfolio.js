import { useState, useEffect, useCallback } from 'react'
import { INITIAL_PORTFOLIO } from '../data/portfolio'
import { fetchQuotes } from '../services/api'

const LS_KEY = 'finsurf_portfolio'

function loadStored() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function usePortfolio() {
  const [positions, setPositions] = useState(() => loadStored() || INITIAL_PORTFOLIO)
  const [quotes, setQuotes] = useState({})
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(positions))
  }, [positions])

  const refresh = useCallback(async () => {
    if (!positions.length) return
    setLoading(true)
    try {
      const symbols = positions.map(p => p.symbol)
      const results = await fetchQuotes(symbols)
      const map = {}
      results.forEach(q => { map[q.symbol] = q })
      setQuotes(map)
      setLastUpdated(new Date())
    } catch (e) {
      console.warn('Portfolio refresh failed:', e.message)
    } finally {
      setLoading(false)
    }
  }, [positions])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => clearInterval(interval)
  }, [refresh])

  const addPosition = useCallback((pos) => {
    setPositions(prev => {
      const existing = prev.findIndex(p => p.symbol === pos.symbol)
      if (existing >= 0) {
        const updated = [...prev]
        const old = updated[existing]
        const totalShares = old.shares + pos.shares
        const newAvg = (old.shares * old.avgCost + pos.shares * pos.avgCost) / totalShares
        updated[existing] = { ...old, shares: totalShares, avgCost: +newAvg.toFixed(4) }
        return updated
      }
      return [...prev, pos]
    })
  }, [])

  const removePosition = useCallback((symbol) => {
    setPositions(prev => prev.filter(p => p.symbol !== symbol))
  }, [])

  const updatePosition = useCallback((symbol, updates) => {
    setPositions(prev => prev.map(p => p.symbol === symbol ? { ...p, ...updates } : p))
  }, [])

  const enriched = positions.map(pos => {
    const q = quotes[pos.symbol]
    const price      = q?.price ?? null
    const costBasis  = pos.shares * pos.avgCost
    const mktValue   = price !== null ? price * pos.shares : null
    const gainLoss   = mktValue !== null ? mktValue - costBasis : null
    const gainLossPct= gainLoss !== null ? (gainLoss / costBasis) * 100 : null
    const todayGL    = q?.change !== null ? q.change * pos.shares : null
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
    refresh,
    addPosition,
    removePosition,
    updatePosition,
    summary: { totalCost, totalValue, totalGL, totalGLPct, todayTotal },
  }
}
