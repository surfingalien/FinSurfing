import { useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'

const SIGNAL_COLOR = { BUY: '#00ffcc', SELL: '#f87171', HOLD: '#94a3b8' }
const EVENT_TYPES = new Set(['analysis', 'analysis_error', 'entry_zone', 'signal-flip'])

/**
 * useAlertStream
 *
 * Opens a persistent SSE connection to /api/alerts/stream when signed in.
 * When an alert-triggered AI analysis arrives, calls onAnalysis(event).
 * Auto-reconnects on disconnect (up to 10 retries with exponential backoff).
 *
 * The stream needs a signed-in user, and EventSource cannot send an
 * Authorization header, so it is read with fetch (authFetch) instead.
 * A guest opens no stream.
 */
export function useAlertStream(onAnalysis) {
  const { authFetch, isAuthenticated } = useAuth()
  const ctrlRef    = useRef(null)
  const retries    = useRef(0)
  const timerRef   = useRef(null)
  const onAnalysisRef = useRef(onAnalysis)
  onAnalysisRef.current = onAnalysis

  const connect = useCallback(async () => {
    ctrlRef.current?.abort()
    if (!isAuthenticated) return
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    try {
      const res = await authFetch('/api/alerts/stream', { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } })
      if (res.status === 401 || res.status === 403) return   // signed out — nothing to retry
      if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
      retries.current = 0
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop()
        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data:'))
          if (!line) continue
          try {
            const event = JSON.parse(line.slice(5).trim())
            if (EVENT_TYPES.has(event.type)) onAnalysisRef.current?.(event)
          } catch {}
        }
      }
      throw new Error('stream closed')
    } catch {
      if (ctrl.signal.aborted) return
      if (retries.current < 10) {
        const delay = Math.min(1000 * 2 ** retries.current, 30_000)
        retries.current++
        timerRef.current = setTimeout(connect, delay)
      }
    }
  }, [authFetch, isAuthenticated])

  useEffect(() => {
    retries.current = 0
    connect()
    return () => {
      ctrlRef.current?.abort()
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
