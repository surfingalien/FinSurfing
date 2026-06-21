import { useState, useCallback, useEffect } from 'react'
import { Clock, Loader2, Play, Trash2 } from 'lucide-react'

// ── Backtest Queue Panel ───────────────────────────────────────────────────────

const QUEUE_STRATEGY_IDS = ['sma_crossover', 'rsi_threshold', 'macd_signal', 'bb_reversion']
const QUEUE_RANGES       = ['1y', '2y', '5y']

export default function QueuePanel() {
  const [queueState, setQueueState] = useState({ pending: [], running: null, completedCount: 0 })
  const [results,    setResults]    = useState([])
  const [form, setForm] = useState({ symbol: '', strategy: 'sma_crossover', range: '1y', initialCapital: 10000 })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [q, r] = await Promise.all([
        fetch('/api/backtest/queue').then(r => r.json()),
        fetch('/api/backtest/queue/results?limit=20').then(r => r.json()),
      ])
      setQueueState(q)
      setResults(r.results || [])
    } catch {}
  }, [])

  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [refresh])

  const submit = async () => {
    if (!form.symbol.trim()) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/backtest/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, symbol: form.symbol.toUpperCase() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setForm(f => ({ ...f, symbol: '' }))
      refresh()
    } catch (e) { setError(e.message) } finally { setSubmitting(false) }
  }

  const cancel = async (id) => {
    await fetch(`/api/backtest/queue/${id}`, { method: 'DELETE' }).catch(() => {})
    refresh()
  }

  return (
    <div className="space-y-4 p-1">
      {/* Enqueue form */}
      <div className="glass rounded-xl border border-white/[0.08] p-4 space-y-3">
        <h3 className="text-sm font-semibold text-white">Queue a Backtest</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
            placeholder="Symbol (e.g. AAPL)"
            className="col-span-2 sm:col-span-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 outline-none focus:border-indigo-500/40" />
          <select value={form.strategy} onChange={e => setForm(f => ({ ...f, strategy: e.target.value }))}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-sm text-white outline-none">
            {QUEUE_STRATEGY_IDS.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <select value={form.range} onChange={e => setForm(f => ({ ...f, range: e.target.value }))}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-sm text-white outline-none">
            {QUEUE_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={submit} disabled={submitting || !form.symbol.trim()}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 text-sm hover:bg-indigo-500/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Enqueue
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Queue status */}
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span className="flex items-center gap-1"><Clock size={11} /> {queueState.pending?.length || 0} pending</span>
        {queueState.running && <span className="flex items-center gap-1 text-indigo-400"><Loader2 size={11} className="animate-spin" /> Running: {queueState.running.job?.symbol} {queueState.running.job?.strategy}</span>}
        <span>{queueState.completedCount || 0} completed</span>
      </div>

      {/* Pending jobs */}
      {queueState.pending?.length > 0 && (
        <div className="space-y-1">
          {queueState.pending.map((p, i) => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs">
              <span className="text-slate-400">#{i + 1} · <span className="text-white font-medium">{p.job.symbol}</span> · {p.job.strategy} · {p.job.range}</span>
              <button onClick={() => cancel(p.id)} className="text-slate-600 hover:text-red-400 transition-colors"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Completed</h4>
          {results.map(r => (
            <div key={r.id} className={`rounded-xl border p-3 text-xs space-y-1 ${r.status === 'done' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{r.job.symbol} · {r.job.strategy} · {r.job.range}</span>
                <span className={r.status === 'done' ? 'text-emerald-400' : 'text-red-400'}>{r.status}</span>
              </div>
              {r.status === 'done' && r.result && (
                <div className="flex gap-4 text-slate-400">
                  <span>Return: <span className={r.result.metrics?.totalReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}>{r.result.metrics?.totalReturn?.toFixed(1)}%</span></span>
                  <span>Trades: {r.result.metrics?.totalTrades}</span>
                  <span>Win: {r.result.metrics?.winRate?.toFixed(0)}%</span>
                  <span>MaxDD: {r.result.metrics?.maxDrawdown?.toFixed(1)}%</span>
                </div>
              )}
              {r.status === 'failed' && <p className="text-red-400">{r.error}</p>}
              <span className="text-slate-600">{new Date(r.finishedAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
