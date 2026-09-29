/**
 * ScreenerView — broad fundamental discovery.
 *
 * Every other discovery surface in this app searched a hardcoded ~20-ticker
 * list. This one screens the market on measured fundamentals and ranks on
 * yield QUALITY (coverage-adjusted) rather than raw yield, because sorting by
 * yield puts the dividends most likely to be CUT at the top.
 *
 * The ranking is computed server-side by lib/fundamental-screen.js. The AI
 * only writes the one-line explanation and cannot reorder or add a name, so a
 * card's numbers and its position are always the deterministic result.
 */

import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Search, TrendingUp, ShieldAlert, Loader2, Info, CheckCircle2, SlidersHorizontal,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const FLAG_COPY = {
  'value-trap-risk':   { label: 'Value trap risk',   tone: 'text-red-400 bg-red-500/10 border-red-500/25' },
  'unfunded-dividend': { label: 'Unfunded dividend', tone: 'text-red-400 bg-red-500/10 border-red-500/25' },
  'negative-earnings': { label: 'Negative earnings', tone: 'text-red-400 bg-red-500/10 border-red-500/25' },
  'strained-payout':   { label: 'Strained payout',   tone: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
  'leveraged':         { label: 'Leveraged',         tone: 'text-amber-400 bg-amber-500/10 border-amber-500/25' },
}

const fmtPct = (v, dp = 1) => (v == null ? '—' : `${Number(v).toFixed(dp)}%`)
const fmtCap = (v) => {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`
  return `$${v}`
}

const scoreTone = (s) =>
  s == null ? 'text-slate-500' : s >= 70 ? 'text-emerald-400' : s >= 45 ? 'text-amber-400' : 'text-red-400'

function ScoreBar({ label, value }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-slate-500 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-500/20 overflow-hidden">
        <div
          className={`h-full rounded-full ${value >= 70 ? 'bg-emerald-400' : value >= 45 ? 'bg-amber-400' : 'bg-red-400'}`}
          style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
        />
      </div>
      <span className={`text-[10px] font-mono w-7 text-right ${scoreTone(value)}`}>{value ?? '—'}</span>
    </div>
  )
}

function StockCard({ row, rank, onAnalyze }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(rank * 0.02, 0.3) }}
      className="glass rounded-2xl p-4"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 font-mono">#{rank + 1}</span>
            <button
              onClick={() => onAnalyze?.(row.symbol)}
              className="text-base font-bold hover:text-mint-400 transition-colors"
            >
              {row.symbol}
            </button>
          </div>
          <div className="text-[11px] text-slate-500 truncate">{row.name || row.sector || '—'}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-xl font-bold font-mono ${scoreTone(row.composite)}`}>{row.composite}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">composite</div>
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        <ScoreBar label="Yield"  value={row.yieldScore} />
        <ScoreBar label="Profit" value={row.profitScore} />
      </div>

      <div className="grid grid-cols-4 gap-1.5 mb-3 text-center">
        {[
          ['Yield',  fmtPct(row.dividendYield, 2)],
          ['Payout', fmtPct(row.payoutRatio, 0)],
          ['ROE',    fmtPct(row.roe, 0)],
          ['Cap',    fmtCap(row.marketCap)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-500/10 p-1.5">
            <div className="text-[9px] text-slate-500 mb-0.5">{label}</div>
            <div className="text-[11px] font-mono font-semibold">{value}</div>
          </div>
        ))}
      </div>

      {row.flags?.length > 0 && (
        <div className="space-y-1 mb-2">
          {row.flags.map(f => {
            const copy = FLAG_COPY[f.code] || { label: f.code, tone: 'text-amber-400 bg-amber-500/10 border-amber-500/25' }
            return (
              <div key={f.code} className={`flex items-start gap-1.5 text-[10px] px-2 py-1 rounded-lg border ${copy.tone}`}>
                <ShieldAlert className="w-3 h-3 shrink-0 mt-px" />
                <span><span className="font-semibold">{copy.label}</span> — {f.detail}</span>
              </div>
            )
          })}
        </div>
      )}

      {row.explanation && (
        <div className="flex items-start gap-1.5 text-[11px] text-slate-400 pt-2 border-t border-slate-500/15">
          <CheckCircle2 className="w-3 h-3 text-mint-400 shrink-0 mt-0.5" />
          <span>{row.explanation}</span>
        </div>
      )}
    </motion.div>
  )
}

export default function ScreenerView({ onAnalyze }) {
  const { authFetch } = useAuth()
  const [sector, setSector]     = useState('')
  const [minYield, setMinYield] = useState('')
  const [tilt, setTilt]         = useState(50)   // 0 = all profitability, 100 = all yield
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  const run = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await authFetch('/api/screener/run', {
        method: 'POST',
        body: {
          sector:   sector || undefined,
          minYield: minYield === '' ? undefined : Number(minYield),
          weights:  { yield: tilt, profitability: 100 - tilt },
          limit:    25,
        },
      })
      const json = await res.json()
      // This route is heartbeated: the status pins to 200 once the first byte
      // goes out, so a failure arrives in the BODY and res.ok is not enough.
      if (json?.error) {
        setError(json.error)
        setData(json.ranked?.length ? json : null)
        return
      }
      setData(json)
    } catch (e) {
      setError(e.message || 'Screener failed')
    } finally {
      setLoading(false)
    }
  }, [authFetch, sector, minYield, tilt])

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Search className="w-6 h-6 text-mint-400" />
          Fundamental Screener
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Ranks on measured yield quality and profitability — not raw yield, which puts the
          dividends most likely to be cut at the top.
        </p>
      </div>

      <div className="glass rounded-2xl p-4 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] text-slate-500 mb-1 block">Sector (optional)</span>
            <input
              value={sector} onChange={e => setSector(e.target.value)}
              placeholder="e.g. Technology, Healthcare"
              className="w-full bg-slate-500/10 border border-slate-500/20 rounded-xl px-3 py-2 text-sm outline-none focus:border-mint-400/50"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-500 mb-1 block">Minimum yield % (optional)</span>
            <input
              type="number" min="0" step="0.5" value={minYield}
              onChange={e => setMinYield(e.target.value)} placeholder="e.g. 2"
              className="w-full bg-slate-500/10 border border-slate-500/20 rounded-xl px-3 py-2 text-sm outline-none focus:border-mint-400/50"
            />
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5">
            <span className="flex items-center gap-1.5"><SlidersHorizontal className="w-3 h-3" /> Ranking tilt</span>
            <span className="font-mono">{tilt}% yield · {100 - tilt}% profitability</span>
          </div>
          <input
            type="range" min="0" max="100" step="10" value={tilt}
            onChange={e => setTilt(Number(e.target.value))}
            className="w-full accent-mint-400"
          />
        </div>

        <button
          onClick={run} disabled={loading}
          className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Screening…</>
            : <><TrendingUp className="w-4 h-4" /> Run screen</>}
        </button>
      </div>

      {error && (
        <div className="glass rounded-2xl p-4 border border-red-500/25 text-sm text-red-400 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {data?.notes?.length > 0 && (
        <div className="glass rounded-2xl p-3 text-[11px] text-slate-400 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px text-slate-500" />
          <span>{data.notes.join(' · ')}</span>
        </div>
      )}

      {data?.ranked?.length > 0 && (
        <>
          <div className="text-[11px] text-slate-500">
            Scanned {data.candidatesScanned} candidates · scored {data.enriched} on full fundamentals
            {data.excluded?.length > 0 && ` · ${data.excluded.length} excluded for insufficient data`}
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.ranked.map((row, i) => (
              <StockCard key={row.symbol} row={row} rank={i} onAnalyze={onAnalyze} />
            ))}
          </div>
        </>
      )}

      {data && !data.ranked?.length && !error && (
        <div className="glass rounded-2xl p-6 text-center text-sm text-slate-500">
          Nothing cleared the screen. Try widening the sector or lowering the minimum yield.
        </div>
      )}
    </div>
  )
}
