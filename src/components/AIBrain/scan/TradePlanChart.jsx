/**
 * TradePlanChart — the trade plan's levels on the symbol's own daily candles
 * (shared/PriceChart.jsx), with dated facts marked: earnings releases, annual
 * and quarterly reports, your theses and your TradingView alerts. The levels
 * are the same numbers as the TradePlan grid — nothing is recomputed here.
 *
 * Loaded on demand (React.lazy in StockCardParts) so the chart library never
 * weighs down a scan with dozens of cards. The dated facts are best-effort:
 * when they cannot be loaded the chart still shows price and levels.
 */
import { useEffect, useMemo, useState } from 'react'
import { FileCode2 } from 'lucide-react'
import PriceChart, { MARKER_STYLE, LEVEL_COLORS } from '../../shared/PriceChart'
import { fetchChart } from '../../../services/api'
import { useAuth } from '../../../contexts/AuthContext'
import { KINDS, planLevels, snapMarkers } from '../../../../lib/chart-events.js'
import { planToPine } from '../../../../lib/pine-export.js'

export default function TradePlanChart({ symbol, plan, price, asOf = null }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [state, setState] = useState({ loading: true, candles: [], error: null })
  const [events, setEvents] = useState([])

  useEffect(() => {
    let live = true
    fetchChart(symbol, '1d', '1y')
      .then(d => live && setState({ loading: false, candles: d.candles, error: null }))
      .catch(e => live && setState({ loading: false, candles: [], error: e.message }))
    return () => { live = false }
  }, [symbol])

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let live = true
    authFetch(`/api/research-desk/${encodeURIComponent(symbol)}/chart-events`)
      .then(r => (r.ok ? r.json() : { events: [] }))
      .then(d => live && setEvents(d.events || []))
      .catch(() => {})
    return () => { live = false }
  }, [symbol, authFetch, isAuthenticated])

  const levels = useMemo(() => {
    const l = planLevels(plan)
    return Number.isFinite(price) ? [...l, { price, label: 'Now', role: 'price' }] : l
  }, [plan, price])
  const days = useMemo(() => state.candles.map(c => new Date(c.time).toISOString().slice(0, 10)), [state.candles])
  const snapped = useMemo(() => snapMarkers(events, days), [events, days])
  const kinds = useMemo(() => [...new Set(snapped.markers.map(m => m.kind))], [snapped])

  const downloadPine = () => {
    const script = planToPine({ symbol, levels: planLevels(plan), basis: plan.basis === 'technical' ? 'reference' : 'thesis', asOf })
    if (!script) return
    const url = URL.createObjectURL(new Blob([script], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url; a.download = `${symbol}-levels.pine`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  if (state.loading) return <div className="h-[220px] flex items-center justify-center text-[10px] text-slate-500">Loading {symbol} chart…</div>
  if (state.error || state.candles.length < 5) return <p className="text-[10px] text-slate-500 py-2">No price history to draw the levels on{state.error ? ` (${state.error})` : ''}.</p>

  return (
    <div className="mt-2">
      <PriceChart candles={state.candles} levels={levels} markers={snapped.markers} height={220} levelTitles={false} label={`${symbol} daily candles with the trade plan's levels`} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[9px] text-slate-500">
        <span>Daily candles, last year. Lines are the plan above:</span>
        {[['entry', 'entry'], ['stop', 'stop'], ['target', 'targets'], ['price', 'now']].map(([role, name]) => (
          <span key={role} className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed" style={{ borderColor: LEVEL_COLORS[role] }} aria-hidden="true" />{name}</span>
        ))}
        {kinds.map(k => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: MARKER_STYLE[k]?.color }} aria-hidden="true" />
            <b className="font-semibold text-slate-400">{MARKER_STYLE[k]?.text}</b> {KINDS[k]?.label || k}
          </span>
        ))}
        <button type="button" onClick={downloadPine} title="Download these levels as a Pine Script. Paste it into TradingView's Pine Editor to see the same lines on your own chart. It draws lines only — no orders, no alerts."
          className="ml-auto inline-flex items-center gap-1 text-slate-400 hover:text-white underline underline-offset-2">
          <FileCode2 className="w-3 h-3" aria-hidden="true" /> Levels for TradingView
        </button>
      </div>
    </div>
  )
}
