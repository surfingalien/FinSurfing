import { Brain } from 'lucide-react'
import { AGENTS } from './constants'

/* ── AgentNotesPanel ──────────────────────────────────────── */
export default function AgentNotesPanel({ notes }) {
  return (
    <div className="glass rounded-xl p-4 border border-white/[0.06]">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-3.5 h-3.5 text-mint-400" />
        <span className="text-xs font-semibold text-mint-400">Agent Market Views</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {AGENTS.map(a => (
          <div key={a.key} className={`rounded-lg p-2.5 ${a.bg} border ${a.border}`}>
            <div className={`flex items-center gap-1 mb-1 text-[10px] font-semibold ${a.color}`}>
              <a.icon className="w-2.5 h-2.5" />{a.label}
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">{notes?.[a.key === 'fundamental' ? 'fundamentalAnalyst' : a.key === 'technical' ? 'technicalAnalyst' : a.key === 'sentiment' ? 'sentimentAnalyst' : a.key === 'macro' ? 'macroEconomist' : 'riskManager']}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
