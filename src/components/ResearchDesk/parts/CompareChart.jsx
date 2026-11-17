/**
 * CompareChart — the compared symbols as percent change from the first day
 * they all have (lib/chart-events.js:indexSeries). One scale, so the lines can
 * be read against each other; a symbol with no history is named, not drawn flat.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import PriceChart, { LINE_COLORS } from '../../shared/PriceChart'
import { fetchChart } from '../../../services/api'
import { indexSeries } from '../../../../lib/chart-events.js'

const RANGES = [['6mo', '6 months'], ['1y', '1 year'], ['2y', '2 years']]

export default function CompareChart({ symbols }) {
  const [range, setRange] = useState('1y')
  const [state, setState] = useState({ loading: true, by: {} })
  const key = symbols.join(',')

  useEffect(() => {
    let live = true
    setState({ loading: true, by: {} })
    Promise.all(symbols.map(s => fetchChart(s, '1d', range)
      .then(d => [s, d.candles.map(c => ({ date: new Date(c.time).toISOString().slice(0, 10), close: c.close }))], () => [s, []])))
      .then(rows => live && setState({ loading: false, by: Object.fromEntries(rows) }))
    return () => { live = false }
  }, [key, range]) // eslint-disable-line react-hooks/exhaustive-deps

  const idx = useMemo(() => indexSeries(state.by), [state.by])
  const lines = useMemo(() => idx.series.map((s, i) => ({ name: s.symbol, points: s.points, color: LINE_COLORS[i % LINE_COLORS.length] })), [idx])

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-xs font-semibold">Price path, as percent change{idx.from ? <span className="font-normal text-slate-500"> · from {idx.from}, the first day all of them have</span> : ''}</h3>
        <div className="flex gap-1" role="group" aria-label="Chart range">
          {RANGES.map(([id, name]) => (
            <button key={id} type="button" onClick={() => setRange(id)} aria-pressed={range === id}
              className={`px-2 py-1 rounded-lg text-[11px] border ${range === id ? 'bg-mint-400/15 text-mint-400 border-mint-400/30' : 'text-slate-400 border-slate-500/20 hover:text-white'}`}>{name}</button>
          ))}
        </div>
      </div>
      {state.loading && <div className="h-[280px] flex items-center justify-center text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading prices…</div>}
      {!state.loading && lines.length === 0 && <p className="text-xs text-amber-300 py-3">These symbols share no days of price history, so there is nothing to draw.</p>}
      {!state.loading && lines.length > 0 && (
        <>
          <PriceChart lines={lines} percent height={280} label={`Percent change of ${lines.map(l => l.name).join(', ')} since ${idx.from}`} />
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 mt-2">
            {lines.map(l => {
              const last = l.points[l.points.length - 1]?.value
              return <span key={l.name} className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-0.5" style={{ background: l.color }} aria-hidden="true" /><b className="font-semibold text-slate-300">{l.name}</b> {last > 0 ? '+' : last < 0 ? '−' : ''}{Math.abs(last).toFixed(1)}%</span>
            })}
            {idx.skipped.length > 0 && <span className="text-amber-300">No price history: {idx.skipped.join(', ')}.</span>}
          </p>
        </>
      )}
    </div>
  )
}
