/**
 * TradePlanChart — the trade plan's levels drawn on the symbol's own daily
 * closes: entry range (blue), stop range (red), the profit-booking levels
 * (green) and the current price. Same levels as the TradePlan grid, nothing
 * recomputed here — it only shows where they sit against recent price action.
 * Loaded on demand (React.lazy in StockCardParts) so recharts never weighs
 * down a scan with dozens of cards.
 */
import { useEffect, useState } from 'react'
import { ComposedChart, Line, XAxis, YAxis, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts'
import { fetchChart } from '../../../services/api'

const COLORS = { entry: '#3b82f6', stop: '#ef4444', book: '#10b981', price: '#94a3b8' }
const money = v => (v == null ? '—' : `$${Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toPrecision(4)}`)
const day = t => new Date(t).toISOString().slice(5, 10)

/** Bands to draw and a y-domain that keeps every level and the price path in view. */
function bandsOf(plan) {
  const bands = [
    { key: 'entry', label: 'Entry', lo: plan.entry?.low, hi: plan.entry?.high, color: COLORS.entry },
    { key: 'stop', label: 'Stop', lo: plan.stop?.low, hi: plan.stop?.high, color: COLORS.stop },
    // Booking labels read "T1 — book partial profit"; the margin fits only the T1/T2 part.
    ...(plan.booking || []).map(b => ({ key: b.label, label: String(b.label).split(/\s+[—-]\s+/)[0], lo: b.low, hi: b.high, color: COLORS.book })),
  ]
  return bands.filter(b => Number.isFinite(b.lo) && Number.isFinite(b.hi))
}

function domainOf(closes, bands, price) {
  const vals = [...closes, ...bands.flatMap(b => [b.lo, b.hi]), price].filter(Number.isFinite)
  if (!vals.length) return ['auto', 'auto']
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.06 || hi * 0.02
  return [+(lo - pad).toPrecision(6), +(hi + pad).toPrecision(6)]
}

export default function TradePlanChart({ symbol, plan, price }) {
  const [state, setState] = useState({ loading: true, rows: [], error: null })

  useEffect(() => {
    let live = true
    fetchChart(symbol, '1d', '6mo')
      .then(d => live && setState({ loading: false, rows: d.candles.map(c => ({ t: c.time, close: c.close })), error: null }))
      .catch(e => live && setState({ loading: false, rows: [], error: e.message }))
    return () => { live = false }
  }, [symbol])

  if (state.loading) return <div className="h-[180px] flex items-center justify-center text-[10px] text-slate-500">Loading {symbol} chart…</div>
  if (state.error || state.rows.length < 5) return <p className="text-[10px] text-slate-500 py-2">No price history to draw the levels on{state.error ? ` (${state.error})` : ''}.</p>

  const bands = bandsOf(plan)
  const last = Number.isFinite(price) ? price : state.rows.at(-1).close
  const domain = domainOf(state.rows.map(r => r.close), bands, last)

  return (
    <div className="mt-2" aria-label={`${symbol} price with the trade plan's levels`}>
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={state.rows} margin={{ top: 6, right: 52, bottom: 0, left: 0 }}>
            <XAxis dataKey="t" tickFormatter={day} tick={{ fontSize: 9, fill: '#64748b' }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis domain={domain} tick={{ fontSize: 9, fill: '#64748b' }} width={46} axisLine={false} tickLine={false} tickFormatter={v => (v >= 100 ? v.toFixed(0) : v.toPrecision(3))} />
            <Tooltip
              labelFormatter={t => new Date(t).toISOString().slice(0, 10)}
              formatter={v => [money(v), 'Close']}
              contentStyle={{ fontSize: 10, padding: '4px 8px' }}
            />
            {bands.map(b => (
              <ReferenceArea key={b.key} y1={b.lo} y2={b.hi} fill={b.color} fillOpacity={b.color === COLORS.book ? 0.12 : 0.18} stroke={b.color} strokeOpacity={0.5} ifOverflow="extendDomain"
                label={{ value: b.label, position: 'right', fontSize: 9, fill: b.color }} />
            ))}
            <ReferenceLine y={last} stroke={COLORS.price} strokeDasharray="3 3" label={{ value: `now ${money(last)}`, position: 'insideBottomLeft', fontSize: 9, fill: COLORS.price }} />
            <Line type="monotone" dataKey="close" stroke="#6366f1" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[9px] text-slate-500 mt-1">Daily closes, last 6 months. Bands are the plan above; the dashed line is the current price.</p>
    </div>
  )
}
