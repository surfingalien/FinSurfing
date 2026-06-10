import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { fmt } from '../../../services/api'

/* ── Mini price chart with levels ───────────────── */
export default function MiniChart({ candles, trade, stance }) {
  if (!candles?.length) return null
  const data = candles.slice(-90).map(c => ({
    t: new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    price: c.close,
  }))
  const color = stance === 'Bullish' ? '#10b981' : stance === 'Bearish' ? '#ef4444' : '#f59e0b'
  const gradId = `rg-${stance}`

  return (
    <div className="glass rounded-xl p-4">
      <div className="text-xs text-slate-400 font-semibold mb-3">90-Day Price + Key Levels</div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="t" tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} interval={14} />
          <YAxis domain={['auto', 'auto']} tick={{ fill: '#475569', fontSize: 9 }} tickLine={false} tickFormatter={v => `$${fmt(v)}`} width={55} />
          <Tooltip
            formatter={v => [`$${fmt(v)}`, 'Price']}
            contentStyle={{ background: 'rgba(10,15,26,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 11 }}
            labelStyle={{ color: '#fff' }}
          />
          {trade?.targets?.[0] && (
            <ReferenceLine y={trade.targets[0].price} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.7}
              label={{ value: `TP1 $${fmt(trade.targets[0].price)}`, fill: '#10b981', fontSize: 9, position: 'right' }} />
          )}
          {trade?.stopLoss && (
            <ReferenceLine y={trade.stopLoss.price} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.7}
              label={{ value: `SL $${fmt(trade.stopLoss.price)}`, fill: '#ef4444', fontSize: 9, position: 'right' }} />
          )}
          {trade?.entryZone && (
            <ReferenceLine y={trade.entryZone.low} stroke="#f59e0b" strokeDasharray="2 4" strokeOpacity={0.5}
              label={{ value: `Entry $${fmt(trade.entryZone.low)}`, fill: '#f59e0b', fontSize: 9, position: 'right' }} />
          )}
          <Area type="monotone" dataKey="price" stroke={color} strokeWidth={1.5}
            fill={`url(#${gradId})`} dot={false} activeDot={{ r: 3, fill: color }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
