/**
 * TimesFMCard — the server's TimesFM price forecast (routes/forecast.js →
 * the TimesFM microservice at TIMESFM_URL). Moved here from ResearchView,
 * the old Quantitative Advisory page, which was no longer reachable. The card
 * renders nothing when the service is not configured or does not answer, so
 * the AI Advisory page shows it only where the model actually runs.
 *
 * A model forecast, not a measured one: it is labelled as such, with the
 * p10–p90 band beside every point estimate.
 */
import { Brain } from 'lucide-react'

export default function TimesFMCard({ forecast, loading }) {
  if (!loading && !forecast) return null

  if (loading) {
    return (
      <div className="glass rounded-xl p-4 border border-[#6366f1]/15 animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="w-3.5 h-3.5 text-[#6366f1]" />
          <span className="text-xs font-semibold text-slate-400">ML Price Forecast</span>
          <span className="text-[10px] text-slate-600 ml-1">Loading TimesFM…</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {['7D', '30D', '90D'].map(h => (
            <div key={h} className="rounded-lg bg-white/[0.03] p-3 text-center space-y-1.5">
              <div className="text-[10px] text-slate-600">{h}</div>
              <div className="h-4 bg-white/[0.06] rounded mx-auto w-16" />
              <div className="h-3 bg-white/[0.04] rounded mx-auto w-10" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const horizons = [
    { key: '7d',  label: '7-Day' },
    { key: '30d', label: '30-Day' },
    { key: '90d', label: '90-Day' },
  ]

  return (
    <div className="glass rounded-xl p-4 border border-[#6366f1]/20 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-[#6366f1]" />
          <span className="text-xs font-semibold text-slate-300">ML Price Forecast</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#6366f1]/15 text-[#6366f1] border border-[#6366f1]/25">
          Google TimesFM 2.5
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {horizons.map(({ key, label }) => {
          const f  = forecast.forecasts?.[key]
          if (!f) return null
          const up = f.upside >= 0
          return (
            <div key={key} className={`rounded-lg p-3 text-center border ${
              up ? 'bg-emerald-500/[0.04] border-emerald-500/15'
                 : 'bg-red-500/[0.04] border-red-500/15'
            }`}>
              <div className="text-[10px] text-slate-500 mb-1.5">{label}</div>
              <div className="font-mono font-bold text-white text-sm">
                ${f.point?.toFixed(2)}
              </div>
              <div className={`text-xs font-semibold mt-0.5 ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                {up ? '+' : ''}{f.upside?.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-600 mt-1">
                ±{f.range?.toFixed(1)}% range
              </div>
            </div>
          )
        })}
      </div>

      {/* p10–p90 confidence bands */}
      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-white/[0.04]">
        {horizons.map(({ key, label }) => {
          const f = forecast.forecasts?.[key]
          if (!f) return null
          return (
            <div key={key} className="text-center">
              <div className="text-[9px] text-slate-600 mb-0.5">{label} range</div>
              <div className="text-[10px] font-mono text-slate-500">
                <span className="text-red-400/70">${f.p10?.toFixed(2)}</span>
                <span className="text-slate-700 mx-0.5">–</span>
                <span className="text-emerald-400/70">${f.p90?.toFixed(2)}</span>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-[10px] text-slate-700 text-center">
        Transformer model · {forecast.inputBars} daily bars · a model forecast, not a measured record · not financial advice
      </p>
    </div>
  )
}
