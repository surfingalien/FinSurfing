/**
 * TradeSetupView — per-symbol conditional order templates.
 * Inspired by StockSharp's OrderCondition system.
 *
 * For each symbol the user can configure:
 *   - Entry price + zone (low/high)
 *   - Stop-loss (fixed % or trailing %)
 *   - Take-profit target (fixed $ or % above entry)
 *   - Time in force (GTC / Day / Week)
 *   - R:R ratio auto-calculation
 *   - Alert when any level is breached (hooks into existing alert system)
 *
 * Setups are stored in localStorage keyed by symbol.
 * No broker connectivity required — these are planning templates.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Target, Shield, TrendingUp, TrendingDown, Plus, Trash2,
  Search, X, ChevronRight, Zap, RefreshCw, AlertTriangle,
  BarChart2, Clock,
} from 'lucide-react'
import { searchSymbol } from '../../services/api'

const STORAGE_KEY = 'finsurf_trade_setups'

function loadSetups() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}
function saveSetups(setups) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(setups))
}

function getApiKeyHeaders() {
  try {
    const stored = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (stored.finnhub?.trim()) h['x-finnhub-key'] = stored.finnhub.trim()
    if (stored.fmp?.trim())     h['x-fmp-key']     = stored.fmp.trim()
    return h
  } catch { return {} }
}

// ── Risk/Reward calculator ────────────────────────────────────────────────────
function calcRR(entry, stopLoss, target) {
  if (!entry || !stopLoss || !target) return null
  const risk   = Math.abs(entry - stopLoss)
  const reward = Math.abs(target - entry)
  if (risk === 0) return null
  return +(reward / risk).toFixed(2)
}

function calcTrailingStop(entry, trailPct) {
  if (!entry || !trailPct) return null
  return +(entry * (1 - trailPct / 100)).toFixed(4)
}

// ── RR badge ─────────────────────────────────────────────────────────────────
function RRBadge({ rr }) {
  if (!rr) return null
  const color = rr >= 3 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
              : rr >= 2 ? 'text-mint-400 border-mint-500/30 bg-mint-500/10'
              : rr >= 1 ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
              : 'text-red-400 border-red-500/30 bg-red-500/10'
  return (
    <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full border ${color}`}>
      {rr}:1 R:R
    </span>
  )
}

// ── Profit/Loss meter ─────────────────────────────────────────────────────────
function PnLMeter({ entry, stop, target, livePrice }) {
  if (!entry || !stop || !target) return null
  const risk     = Math.abs(entry - stop)
  const reward   = Math.abs(target - entry)
  const stopPct  = ((stop - entry) / entry * 100).toFixed(2)
  const tpPct    = ((target - entry) / entry * 100).toFixed(2)
  const livePct  = livePrice ? ((livePrice - entry) / entry * 100).toFixed(2) : null

  return (
    <div className="space-y-2 mt-3">
      {/* Visual bar */}
      <div className="relative h-3 bg-white/[0.06] rounded-full overflow-hidden flex">
        {/* Stop zone */}
        <div className="h-full bg-red-500/40 rounded-l-full" style={{ width: `${(risk / (risk + reward)) * 50}%` }} />
        {/* Entry center */}
        <div className="h-full w-1 bg-white/60" style={{ margin: '0 auto' }} />
        {/* Target zone */}
        <div className="h-full bg-emerald-500/40 rounded-r-full" style={{ width: `${(reward / (risk + reward)) * 50}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-red-400">Stop {stopPct}%</span>
        <span className="text-slate-500">Entry ${entry}</span>
        <span className="text-emerald-400">Target +{tpPct}%</span>
      </div>
      {livePct != null && (
        <div className={`text-center text-[11px] font-mono font-bold ${+livePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          Live: {+livePct >= 0 ? '+' : ''}{livePct}% from entry
        </div>
      )}
    </div>
  )
}

// ── Setup form ────────────────────────────────────────────────────────────────
function SetupForm({ symbol, initialSetup, onSave, onCancel, livePrice }) {
  const [form, setForm] = useState({
    entry:       initialSetup?.entry       ?? livePrice ?? '',
    stopMode:    initialSetup?.stopMode    ?? 'fixed',   // 'fixed' | 'trailing'
    stopFixed:   initialSetup?.stopFixed   ?? '',
    trailPct:    initialSetup?.trailPct    ?? 5,
    target:      initialSetup?.target      ?? '',
    targetMode:  initialSetup?.targetMode  ?? 'fixed',   // 'fixed' | 'pct'
    targetPct:   initialSetup?.targetPct   ?? 10,
    tif:         initialSetup?.tif         ?? 'GTC',
    notes:       initialSetup?.notes       ?? '',
  })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const entry    = parseFloat(form.entry)   || 0
  const stop     = form.stopMode === 'trailing'
    ? calcTrailingStop(entry, form.trailPct)
    : parseFloat(form.stopFixed) || 0
  const target   = form.targetMode === 'pct'
    ? entry > 0 ? +(entry * (1 + form.targetPct / 100)).toFixed(4) : 0
    : parseFloat(form.target) || 0
  const rr       = calcRR(entry, stop, target)

  const handleSave = () => {
    onSave({
      symbol,
      entry, stopMode: form.stopMode, stopFixed: stop, trailPct: form.trailPct,
      target, targetMode: form.targetMode, targetPct: form.targetPct,
      tif: form.tif, notes: form.notes,
      updatedAt: new Date().toISOString(),
    })
  }

  return (
    <div className="glass rounded-xl p-5 border border-mint-500/20 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Target className="w-4 h-4 text-mint-400" /> {symbol} — Trade Setup
        </h3>
        <RRBadge rr={rr} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Entry price */}
        <div className="col-span-2 sm:col-span-1 space-y-1.5">
          <label className="text-xs text-slate-400">Entry Price</label>
          <div className="flex items-center gap-2">
            <input
              type="number" step="0.01" value={form.entry}
              onChange={e => set('entry', e.target.value)}
              placeholder={livePrice ? `Current: $${livePrice}` : 'e.g. 185.50'}
              className="input flex-1 font-mono text-sm"
            />
            {livePrice && (
              <button onClick={() => set('entry', livePrice)}
                className="text-xs px-2 py-1 rounded-lg bg-mint-500/10 text-mint-400 border border-mint-500/20 shrink-0">
                Use Live
              </button>
            )}
          </div>
        </div>

        {/* TIF */}
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400">Time in Force</label>
          <select value={form.tif} onChange={e => set('tif', e.target.value)}
            className="input w-full text-sm">
            <option value="GTC">Good Till Cancelled</option>
            <option value="Day">Day Only</option>
            <option value="Week">This Week</option>
          </select>
        </div>

        {/* Stop-loss */}
        <div className="col-span-2 space-y-2">
          <label className="text-xs text-slate-400 flex items-center gap-2">
            <Shield className="w-3 h-3 text-red-400" /> Stop-Loss
          </label>
          <div className="flex gap-2">
            <button onClick={() => set('stopMode', 'fixed')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${form.stopMode === 'fixed' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-white/[0.03] text-slate-500 border-white/[0.07]'}`}>
              Fixed $
            </button>
            <button onClick={() => set('stopMode', 'trailing')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${form.stopMode === 'trailing' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-white/[0.03] text-slate-500 border-white/[0.07]'}`}>
              Trailing %
            </button>
          </div>
          {form.stopMode === 'fixed' ? (
            <input type="number" step="0.01" value={form.stopFixed}
              onChange={e => set('stopFixed', e.target.value)}
              placeholder="e.g. 175.00" className="input w-full font-mono text-sm" />
          ) : (
            <div className="flex items-center gap-3">
              <input type="range" min={1} max={20} step={0.5} value={form.trailPct}
                onChange={e => set('trailPct', +e.target.value)}
                className="flex-1 accent-red-400" />
              <span className="font-mono font-bold text-red-400 w-16 text-right text-sm">
                -{form.trailPct}%
                {stop > 0 && <span className="block text-[10px] text-slate-600">${stop}</span>}
              </span>
            </div>
          )}
        </div>

        {/* Take-profit */}
        <div className="col-span-2 space-y-2">
          <label className="text-xs text-slate-400 flex items-center gap-2">
            <Target className="w-3 h-3 text-emerald-400" /> Take-Profit
          </label>
          <div className="flex gap-2">
            <button onClick={() => set('targetMode', 'fixed')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${form.targetMode === 'fixed' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-white/[0.03] text-slate-500 border-white/[0.07]'}`}>
              Fixed $
            </button>
            <button onClick={() => set('targetMode', 'pct')}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${form.targetMode === 'pct' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-white/[0.03] text-slate-500 border-white/[0.07]'}`}>
              % Above Entry
            </button>
          </div>
          {form.targetMode === 'fixed' ? (
            <input type="number" step="0.01" value={form.target}
              onChange={e => set('target', e.target.value)}
              placeholder="e.g. 210.00" className="input w-full font-mono text-sm" />
          ) : (
            <div className="flex items-center gap-3">
              <input type="range" min={1} max={100} step={1} value={form.targetPct}
                onChange={e => set('targetPct', +e.target.value)}
                className="flex-1 accent-emerald-400" />
              <span className="font-mono font-bold text-emerald-400 w-16 text-right text-sm">
                +{form.targetPct}%
                {target > 0 && <span className="block text-[10px] text-slate-600">${target}</span>}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* R:R visual meter */}
      <PnLMeter entry={entry} stop={stop} target={target} livePrice={livePrice} />

      {/* Notes */}
      <div className="space-y-1.5">
        <label className="text-xs text-slate-400">Notes / Thesis</label>
        <textarea
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          rows={2}
          placeholder="Why this trade, what invalidates it…"
          className="input w-full text-sm resize-none"
        />
      </div>

      <div className="flex gap-3">
        <button onClick={onCancel}
          className="flex-1 py-2 rounded-xl border border-white/[0.08] text-slate-400 hover:text-white text-sm transition-colors">
          Cancel
        </button>
        <button onClick={handleSave}
          className="flex-1 py-2 rounded-xl bg-mint-500/20 border border-mint-500/30 text-mint-400 font-semibold text-sm hover:bg-mint-500/30 transition-all">
          Save Setup
        </button>
      </div>
    </div>
  )
}

// ── Setup card (summary view) ─────────────────────────────────────────────────
function SetupCard({ setup, livePrice, onEdit, onDelete }) {
  const rr       = calcRR(setup.entry, setup.stopFixed, setup.target)
  const stopPct  = setup.entry && setup.stopFixed
    ? ((setup.stopFixed - setup.entry) / setup.entry * 100).toFixed(1) : null
  const tpPct    = setup.entry && setup.target
    ? ((setup.target - setup.entry) / setup.entry * 100).toFixed(1) : null
  const liveVsEntry = livePrice && setup.entry
    ? ((livePrice - setup.entry) / setup.entry * 100).toFixed(2) : null

  // Alert states
  const hitStop   = livePrice && setup.stopFixed  && livePrice <= setup.stopFixed
  const hitTarget = livePrice && setup.target     && livePrice >= setup.target

  return (
    <div className={`glass rounded-xl p-4 border transition-all ${
      hitStop   ? 'border-red-500/50 bg-red-500/5' :
      hitTarget ? 'border-emerald-500/50 bg-emerald-500/5' :
      'border-white/[0.07]'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono font-black text-white text-lg">{setup.symbol}</span>
          {rr && <RRBadge rr={rr} />}
          {setup.stopMode === 'trailing' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
              Trailing -{setup.trailPct}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {hitStop   && <span className="text-xs font-bold text-red-400 animate-pulse">⚠ STOP HIT</span>}
          {hitTarget && <span className="text-xs font-bold text-emerald-400 animate-pulse">🎯 TARGET HIT</span>}
          <button onClick={onEdit}  className="text-slate-500 hover:text-mint-400 p-1 transition-colors"><ChevronRight className="w-3.5 h-3.5" /></button>
          <button onClick={onDelete} className="text-slate-600 hover:text-red-400 p-1 transition-colors"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>

      {/* Price levels */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-blue-500/10 rounded-lg p-2 border border-blue-500/15">
          <div className="text-[9px] text-blue-400 mb-1">Entry</div>
          <div className="font-mono text-xs font-bold text-white">${setup.entry}</div>
          {liveVsEntry && (
            <div className={`text-[9px] font-mono mt-0.5 ${+liveVsEntry >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {+liveVsEntry >= 0 ? '+' : ''}{liveVsEntry}%
            </div>
          )}
        </div>
        <div className={`rounded-lg p-2 border ${hitStop ? 'bg-red-500/20 border-red-500/40' : 'bg-red-500/10 border-red-500/15'}`}>
          <div className="text-[9px] text-red-400 mb-1">Stop Loss</div>
          <div className="font-mono text-xs font-bold text-red-400">${setup.stopFixed}</div>
          {stopPct && <div className="text-[9px] text-slate-600">{stopPct}%</div>}
        </div>
        <div className={`rounded-lg p-2 border ${hitTarget ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-emerald-500/10 border-emerald-500/15'}`}>
          <div className="text-[9px] text-emerald-400 mb-1">Target</div>
          <div className="font-mono text-xs font-bold text-emerald-400">${setup.target}</div>
          {tpPct && <div className="text-[9px] text-slate-600">+{tpPct}%</div>}
        </div>
      </div>

      {/* Live price bar */}
      {livePrice && setup.entry && setup.stopFixed && setup.target && (
        <PnLMeter entry={setup.entry} stop={setup.stopFixed} target={setup.target} livePrice={livePrice} />
      )}

      {/* Notes + TIF */}
      <div className="flex items-center justify-between mt-3 text-[10px] text-slate-600">
        <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {setup.tif}</span>
        {setup.notes && <span className="truncate max-w-[200px] italic">"{setup.notes}"</span>}
        <span>{setup.updatedAt ? new Date(setup.updatedAt).toLocaleDateString() : ''}</span>
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function TradeSetupView({ portfolio }) {
  const [setups,    setSetups]    = useState(loadSetups)
  const [editing,   setEditing]   = useState(null)   // symbol being edited
  const [adding,    setAdding]    = useState(false)
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [searching, setSearching] = useState(false)
  const [livePrices,setLivePrices] = useState({})

  // Persist
  useEffect(() => { saveSetups(setups) }, [setups])

  // Fetch live prices for all setup symbols
  useEffect(() => {
    const syms = Object.keys(setups)
    if (!syms.length) return
    fetch(`/api/quote?symbols=${syms.map(encodeURIComponent).join(',')}`, { headers: getApiKeyHeaders() })
      .then(r => r.json())
      .then(d => {
        const m = {}
        for (const q of d?.quoteResponse?.result ?? []) {
          if (q.regularMarketPrice != null) m[q.symbol] = q.regularMarketPrice
        }
        setLivePrices(m)
      }).catch(() => {})
  }, [Object.keys(setups).join(',')])

  const handleSearch = async (q) => {
    setQuery(q)
    if (!q.trim() || q.length < 2) { setResults([]); return }
    setSearching(true)
    try { setResults((await searchSymbol(q)).slice(0, 5)) } catch {}
    setSearching(false)
  }

  const saveSetup = useCallback((setup) => {
    setSetups(s => ({ ...s, [setup.symbol]: setup }))
    setEditing(null)
    setAdding(false)
    setQuery('')
    setResults([])
  }, [])

  const deleteSetup = (sym) => setSetups(s => { const n = { ...s }; delete n[sym]; return n })

  // Portfolio symbols for quick-add
  const portfolioSymbols = (portfolio?.positions ?? []).map(p => p.symbol)

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
            <Target className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Trade Setups</h1>
            <p className="text-xs text-slate-500">Stop-loss · Take-profit · Trailing stop — with live R:R calculator</p>
          </div>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="btn-primary flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" /> New Setup
        </button>
      </div>

      {/* Add new: symbol search */}
      {adding && !editing && (
        <div className="glass rounded-xl p-4 border border-mint-500/20 space-y-3">
          <p className="text-xs text-slate-400 font-medium">Search or pick a symbol to set up:</p>

          {/* Portfolio symbols */}
          {portfolioSymbols.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {portfolioSymbols.filter(s => !setups[s]).map(s => (
                <button key={s} onClick={() => setEditing(s)}
                  className="px-2.5 py-1 glass rounded-md text-xs font-mono text-slate-400 hover:text-mint-400 border border-white/[0.06] hover:border-mint-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              value={query}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search ticker or company…"
              className="input pl-9 w-full font-mono"
            />
            {results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 z-30 glass border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
                {results.map(r => (
                  <button key={r.symbol} onClick={() => { setEditing(r.symbol); setResults([]) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.06] text-left">
                    <span className="font-mono font-bold text-mint-400 w-14 text-sm">{r.symbol}</span>
                    <span className="text-sm text-slate-300 truncate">{r.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={() => { setAdding(false); setQuery(''); setResults([]) }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Cancel
          </button>
        </div>
      )}

      {/* Active setup form */}
      {editing && (
        <SetupForm
          symbol={editing}
          initialSetup={setups[editing] ?? null}
          livePrice={livePrices[editing] ?? null}
          onSave={saveSetup}
          onCancel={() => { setEditing(null); setAdding(false) }}
        />
      )}

      {/* Empty state */}
      {Object.keys(setups).length === 0 && !adding && !editing && (
        <div className="glass rounded-2xl p-16 text-center space-y-4">
          <Target className="w-12 h-12 text-blue-400/30 mx-auto" />
          <div>
            <p className="text-white font-semibold">No trade setups yet</p>
            <p className="text-slate-500 text-sm mt-1">
              Define entry, stop-loss, and take-profit for any symbol.
              The R:R calculator updates in real time as you adjust levels.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="btn-primary flex items-center gap-2 mx-auto">
            <Plus className="w-4 h-4" /> Create First Setup
          </button>
        </div>
      )}

      {/* Saved setups grid */}
      {Object.keys(setups).length > 0 && !editing && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">{Object.keys(setups).length} active setup{Object.keys(setups).length > 1 ? 's' : ''}</span>
            <span className="text-[10px] text-slate-600">Prices refresh on load</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Object.values(setups).map(setup => (
              <SetupCard
                key={setup.symbol}
                setup={setup}
                livePrice={livePrices[setup.symbol] ?? null}
                onEdit={() => setEditing(setup.symbol)}
                onDelete={() => deleteSetup(setup.symbol)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
