import { useState } from 'react'
import { Search, Zap, Plus } from 'lucide-react'

// ── Skills Tab ────────────────────────────────────────────────────────────────

export default function SkillsTab({ skills }) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const filtered = skills.filter(s =>
    (!search || s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase()))
  )

  const tagColors = ['text-indigo-400 bg-indigo-500/10', 'text-purple-400 bg-purple-500/10', 'text-cyan-400 bg-cyan-500/10', 'text-emerald-400 bg-emerald-500/10']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">FinSurfing Skills</h2>
          <p className="text-xs text-slate-500 mt-0.5">AI capabilities registered in the system</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search skills…"
              className="w-48 bg-white/[0.04] border border-white/[0.06] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-slate-600 outline-none focus:border-indigo-500/40 transition-colors" />
          </div>
          <span className="text-[10px] text-slate-500">{filtered.length} capabilities</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {filtered.map((s, idx) => (
          <div key={s.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-indigo-500/25 transition-all group">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                  <Zap size={15} className="text-indigo-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{s.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono truncate max-w-[140px]">{s.endpoint}</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">{s.status}</span>
            </div>
            <div className="text-[10px] text-slate-400 mb-3">{s.description}</div>
            {s.tags && (
              <div className="flex flex-wrap gap-1">
                {s.tags.map((tag, ti) => (
                  <span key={tag} className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${tagColors[ti % tagColors.length]}`}>{tag}</span>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Create new */}
        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all min-h-[140px]">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] flex items-center justify-center mb-2">
            <Plus size={15} className="text-slate-500" />
          </div>
          <p className="text-sm text-slate-500">Add New Skill</p>
          <p className="text-[10px] text-slate-600 mt-0.5">Register a capability</p>
        </div>
      </div>
    </div>
  )
}
