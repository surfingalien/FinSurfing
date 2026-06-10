import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { fmt } from '../../../services/api'
import { SIGNAL_TYPES } from '../../../services/aiEngine'

/* ── Mini price chart ────────────────────────────── */
export default function PriceChart({ candles, advisory }) {
  if (!candles?.length) return null
  const cfg  = SIGNAL_TYPES[advisory.signal] || SIGNAL_TYPES.HOLD
  const data = candles.slice(-90).map(c => ({
    t: new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    price: c.close,
  }))
  const h = advisory.horizons?.[1]  // swing horizon levels
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 60, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="ai-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cfg.color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={cfg.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
        <XAxis dataKey="t" tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} interval={14} />
        <YAxis domain={['auto', 'auto']} tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} tickFormatter={v => `$${fmt(v)}`} width={55} />
        <Tooltip formatter={v => [`$${fmt(v)}`, 'Price']}
          contentStyle={{ background: 'rgba(10,15,26,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
          labelStyle={{ color: '#fff' }} />
        {h?.tp1 && <ReferenceLine y={h.tp1} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.7}
          label={{ value: `TP1 $${fmt(h.tp1)}`, fill: '#10b981', fontSize: 9, position: 'right' }} />}
        {h?.tp2 && <ReferenceLine y={h.tp2} stroke="#10b981" strokeDasharray="2 5" strokeOpacity={0.5}
          label={{ value: `TP2 $${fmt(h.tp2)}`, fill: '#10b981', fontSize: 9, position: 'right' }} />}
        {h?.stop && <ReferenceLine y={h.stop} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.7}
          label={{ value: `SL $${fmt(h.stop)}`, fill: '#ef4444', fontSize: 9, position: 'right' }} />}
        <Area type="monotone" dataKey="price" stroke={cfg.color} strokeWidth={2}
          fill="url(#ai-grad)" dot={false} activeDot={{ r: 3, fill: cfg.color }} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
