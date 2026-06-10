import { Server, Plus } from 'lucide-react'

// ── MCP Servers Tab ───────────────────────────────────────────────────────────

export default function MCPTab({ mcps }) {
  const statusColor = { connected: 'bg-emerald-400', idle: 'bg-amber-400', disconnected: 'bg-red-400' }
  const statusText  = { connected: 'text-emerald-400', idle: 'text-amber-400', disconnected: 'text-red-400' }
  const statusBg    = { connected: 'bg-emerald-500/10', idle: 'bg-amber-500/10', disconnected: 'bg-red-500/10' }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">MCP Servers</h2>
          <p className="text-xs text-slate-500 mt-0.5">Model Context Protocol data providers</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-slate-500">{mcps.filter(m => m.status === 'connected').length} / {mcps.length} connected</div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <Plus size={12} /> Add Server
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {mcps.map(m => (
          <div key={m.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-white/[0.12] transition-all">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                  <Server size={15} className="text-slate-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{m.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{m.transport}</div>
                </div>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${statusBg[m.status] || 'bg-slate-500/10'} ${statusText[m.status] || 'text-slate-500'}`}>
                {m.status}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 mb-2">{m.purpose}</div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${statusColor[m.status] || 'bg-slate-600'} ${m.status === 'connected' ? 'shadow-sm shadow-emerald-400/50' : ''}`} />
                <span className="text-[10px] text-slate-600 font-mono">{m.tool}</span>
              </div>
              <span className="text-[10px] text-slate-600">{m.toolCount} tools</span>
            </div>
          </div>
        ))}

        {/* Add new */}
        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all min-h-[120px]">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] flex items-center justify-center mb-2">
            <Plus size={15} className="text-slate-500" />
          </div>
          <p className="text-sm text-slate-500">Add MCP Server</p>
          <p className="text-[10px] text-slate-600 mt-0.5">Connect a new provider</p>
        </div>
      </div>
    </div>
  )
}
