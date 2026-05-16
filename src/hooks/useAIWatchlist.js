import { useState, useEffect, useCallback } from 'react'

const LS_KEY = 'finsurf_ai_watchlist'

function loadStored() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

/**
 * useAIWatchlist — persists AI-recommended stocks in localStorage.
 *
 * Item shape:
 *   { symbol, name, sector, addedFrom ('ai-brain'|'buy-signals'),
 *     addedAt (ISO), entryPrice, takeProfitPrice, stopLossPrice,
 *     targetReturn, stopLoss, horizon, verdict, compositeScore, note }
 *
 * Exports: { items, addStock(item), removeStock(symbol), hasSymbol(symbol), clear() }
 */
export function useAIWatchlist() {
  const [items, setItems] = useState(loadStored)

  // Persist on every change
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(items))
    } catch (e) {
      console.warn('useAIWatchlist: failed to persist', e)
    }
  }, [items])

  /**
   * Add or merge a stock into the AI watchlist.
   * If the symbol already exists, metadata is updated (addedAt preserved
   * unless the source changes, in which case addedAt is refreshed).
   */
  const addStock = useCallback((item) => {
    if (!item?.symbol) return

    const normalized = {
      symbol:          item.symbol?.toUpperCase() ?? '',
      name:            item.name            ?? '',
      sector:          item.sector          ?? '',
      addedFrom:       item.addedFrom       ?? 'ai-brain',   // 'ai-brain' | 'buy-signals'
      addedAt:         item.addedAt         ?? new Date().toISOString(),
      entryPrice:      item.entryPrice      ?? null,
      takeProfitPrice: item.takeProfitPrice ?? null,
      stopLossPrice:   item.stopLossPrice   ?? null,
      targetReturn:    item.targetReturn    ?? null,
      stopLoss:        item.stopLoss        ?? null,
      horizon:         item.horizon         ?? null,
      verdict:         item.verdict         ?? null,
      compositeScore:  item.compositeScore  ?? null,
      note:            item.note            ?? '',
    }

    setItems(prev => {
      const idx = prev.findIndex(s => s.symbol === normalized.symbol)
      if (idx === -1) {
        // New entry — prepend so newest is first
        return [normalized, ...prev]
      }
      // Merge — keep original addedAt unless source changes
      const existing = prev[idx]
      const merged = {
        ...existing,
        ...normalized,
        addedAt: existing.addedFrom !== normalized.addedFrom
          ? new Date().toISOString()
          : existing.addedAt,
        // Preserve user note if the incoming item has none
        note: normalized.note || existing.note,
      }
      const updated = [...prev]
      updated[idx] = merged
      return updated
    })
  }, [])

  /** Remove a stock by symbol. */
  const removeStock = useCallback((symbol) => {
    if (!symbol) return
    setItems(prev => prev.filter(s => s.symbol !== symbol?.toUpperCase()))
  }, [])

  /** Check whether a symbol is already in the watchlist. */
  const hasSymbol = useCallback((symbol) => {
    if (!symbol) return false
    return items.some(s => s.symbol === symbol?.toUpperCase())
  }, [items])

  /** Remove all items from the AI watchlist. */
  const clear = useCallback(() => {
    setItems([])
  }, [])

  return { items, addStock, removeStock, hasSymbol, clear }
}
