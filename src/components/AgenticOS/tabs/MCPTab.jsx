import { useState, useMemo } from 'react'
import { Server, Plus, Activity, Zap, Database, Brain, Globe, Radio, Cpu, Link2 } from 'lucide-react'

// Per-server metadata enrichment
const SERVER_META = {
  'anthropic-claude': { icon: Brain,    color: '#8b5cf6', cat: 'ai',       tag: 'Primary' },
  'groq-llama':       { icon: Zap,      color: '#f59e0b', cat: 'ai',       tag: 'Fallback' },
  'finnhub':          { icon: Activity, color: '#6366f1', cat: 'market',   tag: 'Real-time' },
  'fmp':              { icon: Database, color: '#06b6d4', cat: 'market',   tag: 'Fundamentals' },
  'fred':             { icon: Globe,    color: '#10b981', cat: 'macro',    tag: 'Macro' },
  'sec-edgar':        { icon: Server,   color: '#84cc16', cat: 'alt',      tag: 'Free' },
  'finra':            { icon: Server,   color: '#84cc16', cat: 'alt',      tag: 'Free' },
  'reddit':           { icon: Radio,    color: '#f97316', cat: 'sentiment',tag: 'Social' },
  'binance':          { icon: Zap,      color: '#f59e0b', cat: 'crypto',   tag: 'WSS' },
  'postgres':         { icon: Database, color: '#64748b', cat: 'db',       tag: 'Persist' },
}

const STATUS_BORDER = {
  connected:    'border-emerald-500/25 hover:border-emerald-500/50',
  idle:         'border-amber-500/20  hover:border-amber-500/40',
  disconnected: 'border-red-500/20    hover:border-red-500/40',
}
const STATUS_GLOW = {
  connected:    'shadow-emerald-500/10',
  idle:         'shadow-amber-500/10',
  disconnected: '',
}
const STATUS_DOT = {
  connected:    'bg-emerald-400 shadow-emerald-400/60',
  idle:         'bg-amber-400',
  disconnected: 'bg-red-400',
}
const STATUS_LABEL = {
  connected:    'text-emerald-400 bg-emerald-500/10',
  idle:         'text-amber-400   bg-amber-500/10',
  disconnected: 'text-red-400     bg-red-500/10',
}
const TRANSPORT_COLOR = {
  'HTTP/SSE': 'text-purple-400 bg-purple-500/10',
  'HTTP':     'text-indigo-400 bg-indigo-500/10',
  'WSS':      'text-amber-400  bg-amber-500/10',
  'TCP':      'text-cyan-400   bg-cyan-500/10',
}
const CAT_COLOR = {
  ai:        'text-purple-400  bg-purple-500/10',
  market:    'text-indigo-400  bg-indigo-500/10',
  macro:     'text-emerald-400 bg-emerald-500/10',
  alt:       'text-lime-400    bg-lime-500/10',
  sentiment: 'text-orange-400  bg-orange-500/10',
  crypto:    'text-amber-400   bg-amber-500/10',
  db:        'text-slate-400   bg-slate-500/10',
}

// Mini connectivity map — SVG showing providers grouped by category
function ConnectivityMap({ mcps }) {
  const [hovered, setHovered] = useState(null)

  const W = 560, H = 160
  const CX = W / 2, CY = H / 2 - 8

  // Group by category
  const groups = useMemo(() => {
    const g = {}
    for (const m of mcps) {
      const cat = SERVER_META[m.id]?.cat || 'other'
      if (!g[cat]) g[cat] = []
      g[cat].push(m)
    }
    return g
  }, [mcps])

  // Position groups in a ring around a "FinSurfing" hub
  const catList = Object.keys(groups)
  const positioned = []
  catList.forEach((cat, gi) => {
    const angle = (gi / catList.length) * 2 * Math.PI - Math.PI / 2
    const gx = CX + 90 * Math.cos(angle)
    const gy = CY + 55 * Math.sin(angle)
    groups[cat].forEach((m, si) => {
      const spread = groups[cat].length > 1 ? si / (groups[cat].length - 1) - 0.5 : 0
      const perp = angle + Math.PI / 2
      positioned.push({
        ...m,
        cat,
        x: gx + spread * 26 * Math.cos(perp),
        y: gy + spread * 26 * Math.sin(perp),
      })
    })
  })

  const meta = (m) => SERVER_META[m.id] || {}
  const col  = (m) => {
    if (m.status === 'connected')    return meta(m).color || '#6366f1'
    if (m.status === 'idle')         return '#78716c'
    return '#5c2323'
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0d0d14] p-3 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={11} className="text-slate-500" />
        <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">Connectivity Map</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: 'transparent' }}>
        <defs>
          <radialGradient id="hubglow" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#6366f1" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0"    />
          </radialGradient>
        </defs>
        <ellipse cx={CX} cy={CY} rx={28} ry={24} fill="url(#hubglow)" />

        {/* Edges: each provider → hub */}
        {positioned.map(m => (
          <line key={m.id + '-e'}
            x1={m.x} y1={m.y} x2={CX} y2={CY}
            stroke={col(m)}
            strokeWidth={hovered === m.id ? 1.2 : 0.6}
            strokeOpacity={hovered === m.id ? 0.7 : (m.status === 'connected' ? 0.25 : 0.1)}
          />
        ))}

        {/* Animated pulse along connected edges */}
        {positioned.filter(m => m.status === 'connected').map(m => (
          <circle key={m.id + '-pulse'} r={2} fill={meta(m).color || '#6366f1'} opacity={0.7}>
            <animateMotion dur={`${2 + (m.id.length % 3)}s`} repeatCount="indefinite">
              <mpath xlinkHref={`#path-${m.id}`} />
            </animateMotion>
          </circle>
        ))}
        {positioned.filter(m => m.status === 'connected').map(m => (
          <path key={m.id + '-path'} id={`path-${m.id}`}
            d={`M ${m.x} ${m.y} L ${CX} ${CY}`}
            fill="none" stroke="none" />
        ))}

        {/* Provider nodes */}
        {positioned.map(m => {
          const r = 6
          const c = col(m)
          return (
            <g key={m.id} transform={`translate(${m.x},${m.y})`}
               style={{ cursor: 'pointer' }}
               onMouseEnter={() => setHovered(m.id)}
               onMouseLeave={() => setHovered(null)}>
              <circle r={r + 4} fill={c} fillOpacity={hovered === m.id ? 0.18 : 0.07} />
              <circle r={r} fill={c} opacity={m.status === 'connected' ? 0.9 : 0.35} />
              {m.status === 'connected' && (
                <circle r={r + 6} fill="none" stroke={c} strokeWidth={0.6} strokeOpacity={0.3}>
                  <animate attributeName="r" values={`${r+4};${r+9};${r+4}`} dur="2.5s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" values="0.3;0;0.3" dur="2.5s" repeatCount="indefinite" />
                </circle>
              )}
              {hovered === m.id && (
                <text x={0} y={-r - 5} fontSize={6.5} fill="rgba(226,232,240,0.9)"
                  textAnchor="middle" fontFamily="monospace">{m.name.split(' ')[0]}</text>
              )}
            </g>
          )
        })}

        {/* Hub node */}
        <g transform={`translate(${CX},${CY})`}>
          <circle r={14} fill="#6366f1" fillOpacity={0.12} />
          <circle r={10} fill="#6366f1" opacity={0.85} />
          <text x={0} y={3.5} fontSize={5.5} fill="white" textAnchor="middle" fontFamily="monospace" fontWeight="bold">FS</text>
        </g>

        {/* Legend */}
        {[['connected','#10b981'],['idle','#78716c'],['disconnected','#ef4444']].map(([s,c],i) => (
          <g key={s} transform={`translate(${W-80},${H-28+i*10})`}>
            <circle r={3} fill={c} opacity={0.7} />
            <text x={7} y={4} fontSize={6.5} fill="rgba(148,163,184,0.5)" fontFamily="monospace">{s}</text>
          </g>
        ))}

        {/* Tool count summary */}
        <text x={10} y={H - 8} fontSize={7} fill="rgba(100,116,139,0.45)" fontFamily="monospace">
          {mcps.filter(m => m.status === 'connected').length} connected · {mcps.reduce((a,m) => a + (m.toolCount||0), 0)} total tools
        </text>
      </svg>
    </div>
  )
}

export default function MCPTab({ mcps }) {
  const [filter, setFilter] = useState('all')

  const counts = useMemo(() => ({
    all:         mcps.length,
    connected:   mcps.filter(m => m.status === 'connected').length,
    idle:        mcps.filter(m => m.status === 'idle').length,
    disconnected:mcps.filter(m => m.status === 'disconnected').length,
  }), [mcps])

  const visible = filter === 'all' ? mcps : mcps.filter(m => m.status === filter)
  const totalTools = mcps.reduce((a, m) => a + (m.toolCount || 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">MCP Servers</h2>
          <p className="text-xs text-slate-500 mt-0.5">Model Context Protocol data providers · {totalTools} tools registered</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <Plus size={12} /> Add Server
          </button>
        </div>
      </div>

      {/* Connectivity map */}
      <ConnectivityMap mcps={mcps} />

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-white/[0.03] rounded-lg p-1 border border-white/[0.05]">
        {[['all','All'], ['connected','Live'], ['idle','Idle'], ['disconnected','Offline']].map(([k,l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`flex-1 text-[10px] py-1 px-2 rounded font-mono transition-all ${filter === k ? 'bg-white/[0.08] text-white' : 'text-slate-500 hover:text-slate-300'}`}>
            {l} <span className="opacity-60">({counts[k]})</span>
          </button>
        ))}
      </div>

      {/* Server cards */}
      <div className="grid grid-cols-2 gap-3">
        {visible.map(m => {
          const meta  = SERVER_META[m.id] || {}
          const Icon  = meta.icon ?? Server
          const col   = meta.color ?? '#6366f1'
          const catCls = CAT_COLOR[meta.cat] ?? 'text-indigo-400 bg-indigo-500/10'
          return (
            <div key={m.id}
              className={`rounded-xl border bg-[#12121a] p-4 transition-all shadow-sm
                ${STATUS_BORDER[m.status] || 'border-white/[0.06] hover:border-white/[0.12]'}
                ${STATUS_GLOW[m.status]   || ''}`}>

              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center relative"
                    style={{ background: col + '18', border: `1px solid ${col}30` }}>
                    <Icon size={15} style={{ color: col }} />
                    {/* Animated pulse ring for connected */}
                    {m.status === 'connected' && (
                      <span className="absolute inset-0 rounded-xl animate-ping opacity-20"
                        style={{ background: col }} />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white leading-tight">{m.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${TRANSPORT_COLOR[m.transport] || 'text-slate-400 bg-slate-500/10'}`}>
                        {m.transport}
                      </span>
                      {meta.tag && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${catCls}`}>{meta.tag}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${STATUS_LABEL[m.status] || 'text-slate-400 bg-slate-500/10'}`}>
                    {m.status}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[m.status] || 'bg-slate-600'}
                      ${m.status === 'connected' ? 'shadow-sm' : ''}`} />
                  </div>
                </div>
              </div>

              <div className="text-[10px] text-slate-400 mb-3 leading-relaxed">{m.purpose}</div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Cpu size={9} className="text-slate-600" />
                  <span className="text-[10px] text-slate-600 font-mono truncate max-w-[130px]">{m.tool}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-600">{m.toolCount}</span>
                  <span className="text-[9px] text-slate-700">tools</span>
                </div>
              </div>
            </div>
          )
        })}

        {/* Add new placeholder */}
        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all min-h-[140px]">
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
