import { useState, useEffect, useRef } from 'react'
import { Search, Plus } from 'lucide-react'
import { searchSymbol } from '../../services/api'
import { Dialog, DialogHeader, DialogBody } from '../shared/Dialog'

export default function AddStockModal({ onAdd, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)
  const [shares, setShares] = useState('')
  const [avgCost, setAvgCost] = useState('')
  const [searching, setSearching] = useState(false)
  const inputRef = useRef()

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await searchSymbol(query)
        setResults(r)
      } catch {}
      setSearching(false)
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  // Derive a direct ticker from raw input when search yields nothing
  const directSymbol = !selected && !searching && results.length === 0 && query.trim()
    ? query.trim().toUpperCase().split(/[\s—]+/)[0].replace(/[^A-Z0-9.\-]/g, '').slice(0, 10)
    : null

  const effectiveSymbol = selected?.symbol || directSymbol
  const effectiveName   = selected?.name   || directSymbol
  const canAdd = !!(effectiveSymbol && shares && avgCost)

  const handleAdd = () => {
    if (!canAdd) return
    onAdd({
      symbol:  effectiveSymbol,
      name:    effectiveName,
      shares:  parseFloat(shares),
      avgCost: parseFloat(avgCost),
      sector:  selected?.sector || null,
    })
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && directSymbol) {
      setSelected({ symbol: directSymbol, name: directSymbol })
    }
  }

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader title="Add to Portfolio" onClose={onClose} />
      <DialogBody className="space-y-4">
        {/* Search */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Search Symbol or Company</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setSelected(null) }}
              onKeyDown={handleKeyDown}
              placeholder="Search or type ticker + Enter"
              className="input pl-9"
            />
          </div>
          {results.length > 0 && !selected && (
            <div className="mt-1 glass rounded-lg overflow-hidden border border-white/[0.08]">
              {results.map(r => (
                <button
                  key={r.symbol}
                  onClick={() => { setSelected(r); setQuery(`${r.symbol} — ${r.name}`); setResults([]) }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.06] text-left transition-colors"
                >
                  <span className="font-mono font-semibold text-mint-400 text-sm w-14 shrink-0">{r.symbol}</span>
                  <span className="text-sm text-slate-300 truncate">{r.name}</span>
                  <span className="text-xs text-slate-500 ml-auto shrink-0">{r.exchange}</span>
                </button>
              ))}
            </div>
          )}
          {searching && <div className="text-xs text-slate-500 mt-1 px-1">Searching…</div>}
          {directSymbol && (
            <button
              onClick={() => { setSelected({ symbol: directSymbol, name: directSymbol }); setQuery(directSymbol) }}
              className="mt-1.5 w-full text-left px-3 py-2 text-xs rounded-lg bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.06] transition-colors text-slate-400"
            >
              Add <span className="font-mono font-semibold text-mint-400">{directSymbol}</span> directly (unlisted / delisted / crypto)
            </button>
          )}
        </div>

        {/* Shares */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Number of Shares / Units</label>
          <input
            type="number"
            min="0.001"
            step="0.001"
            value={shares}
            onChange={e => setShares(e.target.value)}
            placeholder="e.g. 10"
            className="input"
          />
        </div>

        {/* Avg cost */}
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Average Cost Basis (per share)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={avgCost}
              onChange={e => setAvgCost(e.target.value)}
              placeholder="e.g. 175.00"
              className="input pl-7"
            />
          </div>
        </div>

        {effectiveSymbol && shares && avgCost && (
          <div className="glass rounded-lg px-4 py-3 text-sm">
            <div className="flex justify-between text-slate-400">
              <span>Total Cost Basis</span>
              <span className="font-mono text-white font-semibold">
                ${(parseFloat(shares) * parseFloat(avgCost)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {!selected?.name && directSymbol && (
              <div className="text-[10px] text-amber-400/70 mt-1">
                Live price data may not be available for this symbol — P&L will show "—" until a provider covers it.
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button
            onClick={handleAdd}
            disabled={!canAdd}
            className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            Add Position
          </button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
