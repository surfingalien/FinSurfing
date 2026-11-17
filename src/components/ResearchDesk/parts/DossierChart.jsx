/**
 * DossierChart — the symbol's candles with what the desk knows drawn on them:
 * the trade plan's levels (the thesis plan once written, else the reference
 * levels), and dated facts as markers — earnings releases and periodic filings
 * from the SEC index, and your own theses.
 *
 * Markers are facts ("this was filed that day"), not signals. Nothing here is
 * recomputed: the levels are the plan's own numbers.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PriceChart, { MARKER_STYLE, LEVEL_COLORS } from '../../shared/PriceChart'
import { fetchChart } from '../../../services/api'
import { KINDS, planLevels, snapMarkers } from '../../../../lib/chart-events.js'

const RANGES = [['6mo', '6 months'], ['1y', '1 year'], ['2y', '2 years'], ['5y', '5 years']]

export default function DossierChart({ symbol, plan, planBasis, call }) {
  const [range, setRange] = useState('1y')
  const [state, setState] = useState({ loading: true, candles: [], error: null })
  const [events, setEvents] = useState({ list: [], notes: [] })
  const [hidden, setHidden] = useState({})

  useEffect(() => {
    let live = true
    setState(s => ({ ...s, loading: true, error: null }))
    fetchChart(symbol, '1d', range)
      .then(d => live && setState({ loading: false, candles: d.candles, error: null }))
      .catch(e => live && setState({ loading: false, candles: [], error: e.message }))
    return () => { live = false }
  }, [symbol, range])

  useEffect(() => {
    let live = true
    setEvents({ list: [], notes: [] })
    call(`/api/research-desk/${encodeURIComponent(symbol)}/chart-events`)
      .then(d => live && setEvents({ list: d.events || [], notes: d.notes || [] }))
      .catch(() => live && setEvents({ list: [], notes: ['Dated events could not be loaded, so the chart shows price and levels only.'] }))
    return () => { live = false }
  }, [symbol, call])

  const levels = useMemo(() => planLevels(plan), [plan])
  const days = useMemo(() => state.candles.map(c => new Date(c.time).toISOString().slice(0, 10)), [state.candles])
  const snapped = useMemo(() => snapMarkers(events.list.filter(e => !hidden[e.kind]), days), [events.list, hidden, days])
  const kinds = useMemo(() => [...new Set(events.list.map(e => e.kind))], [events.list])
  const counts = useMemo(() => {
    const first = days[0], last = days[days.length - 1], c = {}
    for (const e of events.list) if (first && e.date >= first && e.date <= last) c[e.kind] = (c[e.kind] || 0) + 1
    return c
  }, [events.list, days])

  // An event dated after the last bar (an alert from today, before today's bar exists) has no bar to sit on yet.
  const ahead = days.length ? events.list.filter(e => !hidden[e.kind] && e.date > days[days.length - 1]).length : 0

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-semibold">{symbol} — price, levels and dated events</h4>
        <div className="flex gap-1" role="group" aria-label="Chart range">
          {RANGES.map(([id, name]) => (
            <button key={id} type="button" onClick={() => setRange(id)} aria-pressed={range === id}
              className={`px-2 py-1 rounded-lg text-[11px] border ${range === id ? 'bg-mint-400/15 text-mint-400 border-mint-400/30' : 'text-slate-400 border-slate-500/20 hover:text-white'}`}>{name}</button>
          ))}
        </div>
      </div>

      {state.loading && !state.candles.length && <div className="h-[320px] flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading {symbol}…</div>}
      {state.error && <p className="text-xs text-amber-300 py-4">No price history to draw{state.error ? ` (${state.error})` : ''}.</p>}
      {state.candles.length > 0 && <PriceChart candles={state.candles} levels={levels} markers={snapped.markers} label={`${symbol} daily candles with the plan's levels and dated events`} />}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11px] text-slate-400">
        {levels.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-slate-500">{planBasis === 'thesis' ? 'Thesis plan:' : 'Reference levels:'}</span>
            {[['entry', 'entry'], ['stop', 'stop'], ['target', 'targets']].map(([role, name]) => (
              <span key={role} className="inline-flex items-center gap-1"><span className="inline-block w-3 border-t border-dashed" style={{ borderColor: LEVEL_COLORS[role] }} />{name}</span>
            ))}
          </span>
        )}
        {kinds.map(k => (
          <label key={k} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={!hidden[k]} onChange={e => setHidden(h => ({ ...h, [k]: !e.target.checked }))} />
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: MARKER_STYLE[k]?.color }} aria-hidden="true" />
            <span><b className="font-semibold text-slate-300">{MARKER_STYLE[k]?.text}</b> {KINDS[k]?.label || k} <span className="text-slate-500">({counts[k] || 0})</span></span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        {levels.length > 0 && (planBasis === 'thesis' ? 'Levels are the thesis plan’s own numbers. ' : 'Levels come from price action alone — reference levels, not a buy signal. ')}
        Markers are dated facts, not signals; an event on a day the market was closed sits on the next session.
        {ahead > 0 && ` ${ahead} ${ahead === 1 ? 'event is' : 'events are'} newer than the last session shown and will appear once that day has a bar.`}
        {events.notes.length > 0 && ` ${events.notes.join(' ')}`}
      </p>
    </div>
  )
}
