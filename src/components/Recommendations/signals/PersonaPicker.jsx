import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

/* ── Investor persona picker ─────────────────────── */
const STYLE_COLORS = {
  'text-amber-400':   'border-amber-500/30 bg-amber-500/10',
  'text-purple-400':  'border-purple-500/30 bg-purple-500/10',
  'text-emerald-400': 'border-emerald-500/30 bg-emerald-500/10',
  'text-cyan-400':    'border-cyan-500/30 bg-cyan-500/10',
  'text-red-400':     'border-red-500/30 bg-red-500/10',
  'text-indigo-400':  'border-indigo-500/30 bg-indigo-500/10',
  'text-orange-400':  'border-orange-500/30 bg-orange-500/10',
  'text-yellow-400':  'border-yellow-500/30 bg-yellow-500/10',
  'text-teal-400':    'border-teal-500/30 bg-teal-500/10',
  'text-slate-400':   'border-white/[0.08] bg-white/[0.04]',
}

export function PersonaPicker({ selected, onChange, personas }) {
  const [open, setOpen] = useState(false)
  const current = personas.find(p => p.id === selected) ?? personas[0]

  return (
    <div className="relative">
      {/* Collapsed trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08] hover:border-white/[0.15] transition-all"
      >
        <span className="text-xl">{current.emoji}</span>
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">{current.name}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${STYLE_COLORS[current.styleColor] ?? STYLE_COLORS['text-slate-400']} ${current.styleColor}`}>
              {current.style}
            </span>
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{current.tagline}</p>
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
          : <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
        }
      </button>

      {/* Expanded grid */}
      {open && (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 p-3 rounded-xl bg-white/[0.02] border border-white/[0.07]">
          {personas.map(p => {
            const isActive = p.id === selected
            const colors = STYLE_COLORS[p.styleColor] ?? STYLE_COLORS['text-slate-400']
            return (
              <button
                key={p.id}
                onClick={() => { onChange(p.id); setOpen(false) }}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-all ${
                  isActive
                    ? `${colors} border-2`
                    : 'bg-white/[0.03] border-white/[0.06] hover:border-white/[0.15]'
                }`}
              >
                <span className="text-2xl">{p.emoji}</span>
                <span className={`text-xs font-semibold leading-tight ${isActive ? p.styleColor : 'text-white'}`}>
                  {p.name}
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${colors} ${p.styleColor} font-medium`}>
                  {p.style}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
