/**
 * MarkedChart — a symbol's daily candles with dated events marked on them.
 * The caller supplies the events ({date:'YYYY-MM-DD', kind, text}); this loads
 * the candles, places each event on the first session on or after its date
 * (lib/chart-events.js:snapMarkers) and says how many fell outside the range.
 * Load with React.lazy.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PriceChart, { MARKER_STYLE } from './PriceChart'
import { fetchChart } from '../../services/api'
import { KINDS, snapMarkers } from '../../../lib/chart-events.js'

export default function MarkedChart({ symbol, range = '1y', events = [], height = 300, note = null }) {
  const [state, setState] = useState({ loading: true, candles: [], error: null })
  useEffect(() => {
    let live = true
    setState({ loading: true, candles: [], error: null })
    fetchChart(symbol, '1d', range)
      .then(d => live && setState({ loading: false, candles: d.candles, error: null }))
      .catch(e => live && setState({ loading: false, candles: [], error: e.message }))
    return () => { live = false }
  }, [symbol, range])

  const days = useMemo(() => state.candles.map(c => new Date(c.time).toISOString().slice(0, 10)), [state.candles])
  const snapped = useMemo(() => snapMarkers(events, days), [events, days])
  const kinds = useMemo(() => [...new Set(events.map(e => e.kind))], [events])

  if (state.loading) return <div style={{ height }} className="flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading {symbol}…</div>
  if (state.error || !state.candles.length) return <p className="text-xs text-amber-300 py-3">No price history to draw{state.error ? ` (${state.error})` : ''}.</p>
  return (
    <div>
      <PriceChart candles={state.candles} markers={snapped.markers} height={height} label={`${symbol} daily candles with ${snapped.markers.length} marked events`} />
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 mt-2">
        {kinds.map(k => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: MARKER_STYLE[k]?.color }} aria-hidden="true" />
            <b className="font-semibold text-slate-300">{MARKER_STYLE[k]?.text}</b> {KINDS[k]?.label || k}
          </span>
        ))}
        <span className="text-slate-500">
          {snapped.markers.length} marked{snapped.dropped > 0 ? `; ${snapped.dropped} fall outside the price history shown` : ''}. An event on a closed day sits on the next session.{note ? ` ${note}` : ''}
        </span>
      </p>
    </div>
  )
}
