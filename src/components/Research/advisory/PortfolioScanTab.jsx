import { useState } from 'react'
import { Zap, RefreshCw, Cpu } from 'lucide-react'
import { fmt } from '../../../services/api'
import { scanPortfolio, SIGNAL_TYPES } from '../../../services/aiEngine'

/* ── Portfolio Scan Tab ──────────────────────────── */
export default function PortfolioScanTab({ portfolio }) {
  const [scan,    setScan]    = useState(null)
  const [loading, setLoading] = useState(false)

  const runScan = async () => {
    setLoading(true)
    try {
      const results = await scanPortfolio({
        positions: portfolio.positions,
        quotes:    portfolio.quotes,
      })
      setScan(results)
    } finally {
      setLoading(false)
    }
  }

  const signalGroups = scan
    ? Object.entries(SIGNAL_TYPES).map(([key, cfg]) => ({
        key, cfg, items: scan.filter(r => r.signal === key),
      })).filter(g => g.items.length > 0)
    : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Cpu className="w-4 h-4 text-mint-400" /> Portfolio AI Scan
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Instant signal classification for all {portfolio.positions.length} holdings
          </p>
        </div>
        <button onClick={runScan} disabled={loading}
          className="btn-primary flex items-center gap-2">
          {loading
            ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Scanning…</>
            : <><Zap className="w-3.5 h-3.5" />Scan Portfolio</>}
        </button>
      </div>

      {!scan && !loading && (
        <div className="glass rounded-xl p-12 text-center space-y-3">
          <Cpu className="w-10 h-10 text-mint-400/40 mx-auto" />
          <p className="text-slate-500 text-sm">Run the AI scan to classify all portfolio positions with Buy/Sell/Hold signals</p>
          <button onClick={runScan} className="btn-primary mx-auto flex items-center gap-2">
            <Zap className="w-3.5 h-3.5" /> Start Scan
          </button>
        </div>
      )}

      {loading && (
        <div className="glass rounded-xl p-8 flex flex-col items-center gap-3">
          <div className="flex gap-1">
            {[0,1,2,3,4].map(i => (
              <div key={i} className="w-2 h-8 bg-mint-400/40 rounded-full animate-pulse"
                style={{ animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
          <p className="text-slate-400 text-sm">Analyzing {portfolio.positions.length} positions…</p>
        </div>
      )}

      {scan && !loading && (
        <div className="space-y-4">
          {/* Summary row */}
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
            {Object.entries(SIGNAL_TYPES).map(([key, cfg]) => {
              const count = scan.filter(r => r.signal === key).length
              return (
                <div key={key} className={`glass-card text-center border ${count > 0 ? cfg.border : 'border-white/[0.04]'} py-2`}>
                  <div className="text-lg">{cfg.emoji}</div>
                  <div className={`text-lg font-black ${count > 0 ? cfg.text : 'text-slate-700'}`}>{count}</div>
                  <div className="text-[9px] text-slate-600 leading-tight">{cfg.label}</div>
                </div>
              )
            })}
          </div>

          {/* Signal groups */}
          {signalGroups.map(({ key, cfg, items }) => (
            <div key={key}>
              <div className={`flex items-center gap-2 mb-2 text-sm font-semibold ${cfg.text}`}>
                <span>{cfg.emoji}</span> {cfg.label} <span className="text-slate-600 font-normal">({items.length})</span>
              </div>
              <div className="glass rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-xs">
                      <th className="text-left px-4 py-2 text-slate-400 font-medium">Symbol</th>
                      <th className="text-right px-3 py-2 text-slate-400 font-medium">Price</th>
                      <th className="text-right px-3 py-2 text-slate-400 font-medium hidden sm:table-cell">Day %</th>
                      <th className="text-right px-3 py-2 text-slate-400 font-medium">Gain %</th>
                      <th className="text-right px-3 py-2 text-slate-400 font-medium hidden md:table-cell">Mkt Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(r => (
                      <tr key={r.symbol} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5">
                          <div className="font-mono font-bold text-white">{r.symbol}</div>
                          <div className="text-xs text-slate-500 truncate max-w-[120px]">{r.name}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-white">${fmt(r.price)}</td>
                        <td className={`px-3 py-2.5 text-right font-mono text-xs hidden sm:table-cell ${r.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(2)}%
                        </td>
                        <td className={`px-3 py-2.5 text-right font-mono text-xs font-semibold ${r.gainPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {r.gainPct >= 0 ? '+' : ''}{r.gainPct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-400 text-xs hidden md:table-cell">
                          ${r.mktValue?.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
