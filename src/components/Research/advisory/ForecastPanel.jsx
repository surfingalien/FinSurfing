import { GitBranch } from 'lucide-react'
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Line, Area,
} from 'recharts'
import { fmt } from '../../../services/api'

/* ── ML Forecast Panel ───────────────────────────── */
export default function ForecastPanel({ forecast, symbol }) {
  if (!forecast) return null
  const { proba, horizons, fib, chartData, insights, trend } = forecast

  const bullPct = +(proba.bull * 100).toFixed(1)
  const bearPct = +(proba.bear * 100).toFixed(1)
  const bullColor = bullPct >= 60 ? '#10b981' : bullPct >= 50 ? '#f59e0b' : '#ef4444'

  const insightColor = {
    bullish: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    bearish: 'bg-red-500/10 border-red-500/20 text-red-400',
    neutral: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  }

  const fibLevels = fib ? Object.entries(fib.levels).map(([key, price]) => ({
    key, price,
    dist: forecast.price ? (((price - forecast.price) / forecast.price) * 100).toFixed(1) : null,
    isAbove: price > (forecast.price ?? 0),
  })) : []

  return (
    <div className="space-y-4">
      {/* ── Section header ── */}
      <div className="flex items-center gap-3 py-2 border-b border-white/[0.06]">
        <GitBranch className="w-4 h-4 text-indigo-400" />
        <span className="font-semibold text-white">ML Price Forecast</span>
        <span className="text-xs text-slate-600">Linear regression + ATR uncertainty · {trend?.direction ?? 'N/A'} trend</span>
      </div>

      {/* ── Bull/Bear probability ── */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">Directional Probability</span>
          <span className="text-xs text-slate-500">multi-factor model</span>
        </div>
        <div className="space-y-2">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-emerald-400 font-semibold">🐂 Bullish</span>
              <span className="font-mono font-black" style={{ color: bullColor }}>{bullPct}%</span>
            </div>
            <div className="h-4 bg-white/[0.06] rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-1000"
                style={{ width: `${bullPct}%`, background: `linear-gradient(90deg, #10b981, ${bullColor})` }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-red-400 font-semibold">🐻 Bearish</span>
              <span className="font-mono font-black text-red-400">{bearPct}%</span>
            </div>
            <div className="h-4 bg-white/[0.06] rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-red-500/60 transition-all duration-1000"
                style={{ width: `${bearPct}%` }} />
            </div>
          </div>
        </div>
        <p className="text-[10px] text-slate-600 mt-2">
          Derived from RSI · MACD · trend slope · 10-bar momentum · sentiment
        </p>
      </div>

      {/* ── 7 / 30 / 90-day forecast cards ── */}
      <div className="grid grid-cols-3 gap-3">
        {horizons.map(h => {
          const chgColor = h.change >= 0 ? 'text-emerald-400' : 'text-red-400'
          return (
            <div key={h.label} className="glass rounded-xl p-3 text-center border border-white/[0.06]">
              <div className="text-xs font-semibold text-slate-400 mb-2">{h.label}</div>
              <div className="font-mono font-black text-white text-lg">${fmt(h.target)}</div>
              <div className={`text-sm font-bold font-mono mt-0.5 ${chgColor}`}>
                {h.change >= 0 ? '+' : ''}{h.change}%
              </div>
              <div className="text-[10px] text-slate-600 mt-1.5 leading-tight">
                ${fmt(h.low)} – ${fmt(h.high)}
                <br />90% CI
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Forecast chart ── */}
      {chartData?.length > 0 && (
        <div className="glass rounded-xl p-4">
          <div className="text-xs text-slate-400 font-semibold mb-3 flex items-center justify-between">
            <span>90-Day Forecast Chart</span>
            <span className="flex items-center gap-3 text-[10px] text-slate-600">
              <span className="flex items-center gap-1"><span className="w-5 h-0.5 bg-mint-400 inline-block" /> Historical</span>
              <span className="flex items-center gap-1"><span className="w-5 h-0.5 bg-indigo-400 border-dashed inline-block" style={{borderTop:'2px dashed #6366f1'}} /> Forecast</span>
              <span className="flex items-center gap-1"><span className="w-5 h-0.5 bg-indigo-400/30 inline-block" /> 90% CI</span>
            </span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 50, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="fc-hist" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00ffcc" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#00ffcc" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="fc-proj" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.20} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="t" tick={{ fill: '#475569', fontSize: 8 }} tickLine={false} interval={15} />
              <YAxis domain={['auto', 'auto']} tick={{ fill: '#475569', fontSize: 8 }} tickLine={false}
                tickFormatter={v => `$${fmt(v)}`} width={50} />
              <Tooltip
                contentStyle={{ background: 'rgba(10,15,26,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 10 }}
                labelStyle={{ color: '#94a3b8' }}
                formatter={(v, name) => v != null ? [`$${fmt(v)}`, name === 'price' ? 'Close' : name === 'proj' ? 'Forecast' : name === 'high' ? 'CI Upper' : 'CI Lower'] : [null, null]}
              />
              {/* CI band (upper) */}
              <Area type="monotone" dataKey="high" fill="#6366f1" fillOpacity={0.10} stroke="none" connectNulls />
              {/* Historical price */}
              <Area type="monotone" dataKey="price" stroke="#00ffcc" strokeWidth={2}
                fill="url(#fc-hist)" dot={false} connectNulls />
              {/* Forecast projection */}
              <Area type="monotone" dataKey="proj" stroke="#6366f1" strokeWidth={2}
                strokeDasharray="5 3" fill="url(#fc-proj)" dot={false} connectNulls />
              {/* CI lower bound */}
              <Line type="monotone" dataKey="low" stroke="#6366f1" strokeWidth={1}
                strokeDasharray="2 4" strokeOpacity={0.4} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid xl:grid-cols-2 gap-4">
        {/* ── Fibonacci levels ── */}
        {fib && (
          <div className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              📐 Fibonacci Retracement
              <span className="text-[10px] text-slate-600 font-normal ml-auto">60-bar swing</span>
            </h3>
            <div className="space-y-1">
              {fibLevels.map(fl => (
                <div key={fl.key}
                  className={`flex items-center justify-between text-xs py-1 border-b border-white/[0.04] ${fl.isAbove ? 'text-red-400/80' : 'text-emerald-400/80'}`}>
                  <span className="font-mono text-slate-500 w-12">{fl.key}</span>
                  <span className="font-mono font-bold text-white">${fl.price}</span>
                  <span className={fl.isAbove ? 'text-red-400' : 'text-emerald-400'}>
                    {fl.dist > 0 ? '+' : ''}{fl.dist}%
                  </span>
                  <span className="text-slate-600 text-[10px]">{fl.isAbove ? 'Resistance' : 'Support'}</span>
                </div>
              ))}
              {fib.extensions && (
                <div className="pt-1">
                  <div className="text-[10px] text-slate-600 mb-1">Extensions (upside targets)</div>
                  {Object.entries(fib.extensions).map(([key, price]) => (
                    <div key={key} className="flex items-center justify-between text-xs py-1 border-b border-white/[0.04]">
                      <span className="font-mono text-slate-500 w-12">{key}</span>
                      <span className="font-mono font-bold text-amber-400">${price}</span>
                      <span className="text-amber-400">
                        +{forecast.price ? (((price - forecast.price) / forecast.price) * 100).toFixed(1) : '—'}%
                      </span>
                      <span className="text-slate-600 text-[10px]">Extension</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── AI Chart Insights ── */}
        {insights?.length > 0 && (
          <div className="glass rounded-xl p-4 space-y-2">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              💡 AI Chart Insights
            </h3>
            {insights.map((ins, i) => (
              <div key={i}
                className={`flex items-start gap-3 p-2.5 rounded-lg border text-xs ${insightColor[ins.type] ?? insightColor.neutral}`}>
                <span className="text-base shrink-0">{ins.icon}</span>
                <div>
                  <div className="font-bold mb-0.5">{ins.title}</div>
                  <p className="opacity-80 leading-relaxed">{ins.desc}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
