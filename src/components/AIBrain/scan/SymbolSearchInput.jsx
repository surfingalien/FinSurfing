import { Brain, Search, X } from 'lucide-react'

/* ── SymbolSearchInput ─────────────────────────────────────── */
export default function SymbolSearchInput({ value, onChange, onSubmit, disabled }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
      <Search className="w-4 h-4 text-slate-500 shrink-0" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value.toUpperCase())}
        onKeyDown={e => e.key === 'Enter' && !disabled && value.trim() && onSubmit?.()}
        disabled={disabled}
        placeholder="Custom symbols (e.g. NVDA,TSLA,BTC-USD) — press Enter or leave blank for scan mode"
        className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono disabled:opacity-40"
      />
      {value.trim() && !disabled && (
        <button
          onClick={onSubmit}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-all font-medium shrink-0"
        >
          <Brain className="w-3 h-3" /> Analyze
        </button>
      )}
      {value && (
        <button onClick={() => onChange('')} disabled={disabled} className="text-slate-500 hover:text-slate-300 shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
