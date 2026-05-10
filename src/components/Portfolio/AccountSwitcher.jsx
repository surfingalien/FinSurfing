/**
 * AccountSwitcher — compact portfolio selector for the header.
 * Shows active portfolio name + type icon, opens a dropdown with all portfolios.
 */
import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Settings, Check } from 'lucide-react'
import { usePortfolioContext, PORTFOLIO_TYPE_ICONS, PORTFOLIO_TYPE_LABELS } from '../../contexts/PortfolioContext'

export default function AccountSwitcher({ onManage, onCreateNew }) {
  const {
    portfolios, activePortfolio, activePortfolioId,
    setActivePortfolioId, loadingPortfolios,
  } = usePortfolioContext()

  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const select = (id) => {
    setActivePortfolioId(id)
    setOpen(false)
  }

  if (loadingPortfolios) {
    return (
      <div className="h-8 w-36 rounded-lg bg-white/5 animate-pulse" />
    )
  }

  const icon  = PORTFOLIO_TYPE_ICONS[activePortfolio?.type] ?? '◉'
  const label = activePortfolio?.name ?? 'Select Portfolio'

  return (
    <div className="relative" ref={ref}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10
                   border border-white/[0.08] text-sm text-slate-200 transition-all min-w-[140px] max-w-[200px]"
      >
        <span className="shrink-0 text-base leading-none">{icon}</span>
        <span className="flex-1 text-left truncate font-medium text-xs">{label}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full mt-2 left-0 z-50 w-64 rounded-xl
                        bg-[#0f1117] border border-white/10 shadow-2xl shadow-black/60
                        overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">

          {/* Portfolio list */}
          <div className="max-h-60 overflow-y-auto">
            {portfolios.length === 0 ? (
              <p className="px-4 py-3 text-xs text-slate-500">No portfolios yet</p>
            ) : (
              portfolios.map(p => {
                const isActive = p.id === activePortfolioId
                const pIcon = PORTFOLIO_TYPE_ICONS[p.type] ?? '◉'
                const pLabel = PORTFOLIO_TYPE_LABELS[p.type] ?? p.type
                return (
                  <button
                    key={p.id}
                    onClick={() => select(p.id)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
                      ${isActive
                        ? 'bg-[#00ffcc]/10 text-[#00ffcc]'
                        : 'text-slate-300 hover:bg-white/5'
                      }`}
                  >
                    <span className="text-base leading-none shrink-0">{pIcon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold truncate">{p.name}</div>
                      <div className="text-[10px] text-slate-500">{pLabel}</div>
                    </div>
                    {isActive && <Check size={13} className="shrink-0 text-[#00ffcc]" />}
                    {p.is_default && !isActive && (
                      <span className="text-[9px] text-slate-600 shrink-0">default</span>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {/* Footer actions */}
          <div className="border-t border-white/[0.06] p-2 flex gap-1">
            <button
              onClick={() => { setOpen(false); onCreateNew?.() }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
                         text-[11px] text-slate-400 hover:text-[#00ffcc] hover:bg-[#00ffcc]/10 transition-colors"
            >
              <Plus size={12} />
              New Portfolio
            </button>
            <button
              onClick={() => { setOpen(false); onManage?.() }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg
                         text-[11px] text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors"
            >
              <Settings size={12} />
              Manage
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
