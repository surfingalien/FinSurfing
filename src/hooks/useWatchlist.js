import { useState, useEffect, useCallback } from 'react'
import { fetchQuotes, subscribeQuotes } from '../services/api'

const LS_KEY = 'finsurf_watchlist'
const DEFAULT_WATCHLIST = ['SPY', 'QQQ', 'AMZN', 'META', 'NFLX', 'LLY', 'PLTR', 'ARM']

function loadStored() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function useWatchlist() {
  const [symbols, setSymbols] = useState(() => loadStored() || DEFAULT_WATCHLIST)
  const [quotes, setQuotes] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(symbols))
  }, [symbols])

  const refresh = useCallback(async () => {
    if (!symbols.length) return
    setLoading(true)
    try {
      const results = await fetchQuotes(symbols, { force: true })
      setQuotes(results)
    } catch (e) {
      console.warn('Watchlist refresh failed:', e.message)
    } finally {
      setLoading(false)
    }
  }, [symbols])

  useEffect(() => {
    if (!symbols.length) return
    refresh()
    const fullRefresh = setInterval(refresh, 30_000)

    // Real-time stream — merges price ticks; never overwrite valid change with null
    const unsub = subscribeQuotes(symbols, ({ symbol: sym, price, change, changePct }) => {
      setQuotes(prev => prev.map(q =>
        q.symbol === sym
          ? { ...q, price, change: change ?? q.change, changePct: changePct ?? q.changePct }
          : q
      ))
    })

    return () => { clearInterval(fullRefresh); unsub() }
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync watchlist to server so the hourly AI scan uses it
  useEffect(() => {
    if (!symbols.length) return
    fetch('/api/alerts/watchlist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ symbols }),
    }).catch(() => {})
  }, [symbols])

  const addSymbol = useCallback((sym) => {
    setSymbols(prev => prev.includes(sym) ? prev : [...prev, sym.toUpperCase()])
  }, [])

  const removeSymbol = useCallback((sym) => {
    setSymbols(prev => prev.filter(s => s !== sym))
  }, [])

  return { symbols, quotes, loading, refresh, addSymbol, removeSymbol }
}
