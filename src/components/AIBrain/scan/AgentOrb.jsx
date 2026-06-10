/* ── AgentOrb ─────────────────────────────────────────────── */
export default function AgentOrb({ agent, active }) {
  const Icon = agent.icon
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={`
        w-10 h-10 rounded-full flex items-center justify-center border transition-all duration-500
        ${active
          ? `${agent.bg} ${agent.border} ${agent.color} animate-pulse ring-2 ring-offset-1 ring-offset-[#070b14]`
          : 'bg-white/[0.03] border-white/[0.06] text-slate-600'
        }
      `}>
        <Icon className="w-4 h-4" />
      </div>
      <span className={`text-[9px] font-medium transition-colors ${active ? agent.color : 'text-slate-600'}`}>
        {agent.label}
      </span>
    </div>
  )
}
