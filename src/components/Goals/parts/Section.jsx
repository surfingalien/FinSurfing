import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

// ── Section wrapper ────────────────────────────────────────────────────────────
export function Section({ title, icon: Icon, color, count, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="glass rounded-2xl border border-white/[0.06] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-white/[0.02] transition-colors"
      >
        <div className={`p-1.5 rounded-lg ${color} bg-white/[0.05]`}>
          <Icon className={`w-3.5 h-3.5 ${color}`} />
        </div>
        <span className={`text-sm font-semibold ${color}`}>{title}</span>
        {count > 0 && (
          <span className="text-[10px] text-slate-500 bg-white/[0.04] border border-white/[0.08] rounded-full px-1.5 py-0.5">
            {count}
          </span>
        )}
        <span className="ml-auto text-slate-600">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}
