import { useState } from 'react'
import useQuery from '../../hooks/useQuery'
import { fetchJson } from '../../services/api'

const MARKETS = [
  { key: 'crypto',  label: 'Crypto'   },
  { key: 'sectors', label: 'Sectors'  },
  { key: 'indices', label: 'Indices'  },
  { key: 'forex',   label: 'Forex'    },
]

const STALE_MS = 5 * 60_000

function heatColor(val) {
  if (val == null) return '#1e293b'
  if (val >=  4) return '#065f46'
  if (val >=  2) return '#047857'
  if (val >=  0.5) return '#059669'
  if (val >=  0) return '#0f766e'
  if (val >= -0.5) return '#9f1239'
  if (val >= -2) return '#be123c'
  if (val >= -4) return '#e11d48'
  return '#881337'
}

function HeatCell({ cell }) {
  const val = cell.value
  const bg  = heatColor(val)
  const abs = val != null ? Math.abs(val).toFixed(2) : null
  return (
    <div
      className="rounded-lg flex flex-col items-center justify-center p-2 min-h-[72px] cursor-default transition-transform hover:scale-[1.03]"
      style={{ background: bg }}
      title={cell.fullName + (cell.price != null ? ` — $${cell.price}` : '')}
    >
      <div className="text-xs font-bold font-mono text-white truncate max-w-full">{cell.name}</div>
      {val != null && (
        <div className="text-sm font-black font-mono mt-0.5" style={{ color: val >= 0 ? '#6ee7b7' : '#fca5a5' }}>
          {val >= 0 ? '+' : ''}{val.toFixed(2)}%
        </div>
      )}
      {cell.price != null && (
        <div className="text-[10px] text-white/50 mt-0.5">${Number(cell.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
      )}
      {val == null && <div className="text-[10px] text-slate-500">—</div>}
    </div>
  )
}

export default function HeatmapView() {
  const [market, setMarket] = useState('crypto')

  const { data, loading, error } = useQuery(
    `heatmap-${market}`,
    () => fetchJson(`/api/heatmap/${market}`),
    { staleMs: STALE_MS }
  )

  const cells = data?.cells ?? []

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Market Heatmap</h1>
          <p className="text-xs text-slate-500 mt-0.5">24-hour price change across markets</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {MARKETS.map(m => (
            <button
              key={m.key}
              onClick={() => setMarket(m.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${market === m.key ? 'bg-[#00ffcc] text-black' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-white/5 animate-pulse min-h-[72px]" />
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="glass rounded-xl p-6 text-center text-slate-500 text-sm">
          Failed to load {market} heatmap — {error}
        </div>
      )}

      {!loading && !error && cells.length > 0 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {cells.map((cell, i) => <HeatCell key={i} cell={cell} />)}
        </div>
      )}

      {!loading && !error && cells.length === 0 && (
        <div className="glass rounded-xl p-6 text-center text-slate-500 text-sm">No data available</div>
      )}

      {data?.generatedAt && (
        <p className="text-[10px] text-slate-600 mt-3 text-right">
          Updated {new Date(data.generatedAt).toLocaleTimeString()} · {data.cached ? 'cached' : 'live'} · {data.market}
        </p>
      )}
    </div>
  )
}
