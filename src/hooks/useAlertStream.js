import { useEffect, useRef, useCallback } from 'react'

const SIGNAL_COLOR = { BUY: '#00ffcc', SELL: '#f87171', HOLD: '#94a3b8' }

/**
 * useAlertStream
 *
 * Opens a persistent SSE connection to /api/alerts/stream.
 * When an alert-triggered AI analysis arrives, calls onAnalysis(event).
 * Auto-reconnects on disconnect (up to 10 retries with exponential backoff).
 */
export function useAlertStream(onAnalysis) {
  const esRef      = useRef(null)
  const retries    = useRef(0)
  const timerRef   = useRef(null)
  const onAnalysisRef = useRef(onAnalysis)
  onAnalysisRef.current = onAnalysis

  const connect = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null }

    const es = new EventSource('/api/alerts/stream')
    esRef.current = es

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data)
        if (event.type === 'analysis' || event.type === 'analysis_error' || event.type === 'entry_zone' || event.type === 'signal-flip') {
          onAnalysisRef.current?.(event)
        }
      } catch {}
    }

    es.onerror = () => {
      es.close()
      esRef.current = null
      if (retries.current < 10) {
        const delay = Math.min(1000 * 2 ** retries.current, 30_000)
        retries.current++
        timerRef.current = setTimeout(connect, delay)
      }
    }

    es.onopen = () => { retries.current = 0 }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [connect])
}

/**
 * formatAnalysisToast — converts an analysis SSE event to a toast-compatible object
 */
export function formatAnalysisToast(event) {
  if (event.type === 'signal-flip') {
    const icon = event.severity === 'high' ? '⚡' : '↔'
    const dir  = event.source === 'watchlist-analysis' ? 'Watchlist' : 'AI Brain'
    return {
      id:      `flip-${event.symbol}-${Date.now()}`,
      type:    'signal_performance',
      title:   `${icon} ${event.symbol} signal flipped`,
      content: `${dir}: ${event.from} → ${event.to}${event.severity === 'high' ? ' (bull/bear cross)' : ''}`,
      color:   event.severity === 'high' ? '#f59e0b' : '#94a3b8',
      data:    event,
    }
  }

  if (event.type === 'entry_zone') {
    const fmt = n => n != null ? `$${Number(n).toFixed(2)}` : '—'
    return {
      id:      `entry-zone-${Date.now()}`,
      type:    'signal_performance',
      title:   `${event.symbol} entered buy zone`,
      content: `Price ${fmt(event.currentPrice)} is inside AI Brain entry zone ${fmt(event.entryZoneLow)}–${fmt(event.entryZoneHigh)} · ${event.verdict ?? 'Buy'} · score ${event.compositeScore ?? '—'}`,
      color:   '#00ffcc',
      data:    event,
    }
  }

  if (event.type === 'analysis_error') {
    return {
      id:      `alert-${Date.now()}`,
      type:    'signal_performance',
      title:   `${event.symbol} analysis failed`,
      content: event.error || 'Analysis unavailable',
    }
  }

  const color = SIGNAL_COLOR[event.signal] || '#94a3b8'
  const dir   = event.triggeredBy?.type === 'above' ? '▲ above' : '▼ below'

  return {
    id:      `alert-${Date.now()}`,
    type:    'signal_performance',
    title:   `${event.symbol} — ${event.signal}`,
    content: `Alert fired (${dir} $${event.triggeredBy?.threshold}) · ${event.confidence}% confidence · Entry $${event.entry}`,
    color,
    data:    event,
  }
}
