/**
 * AgentHubView.jsx
 *
 * 4-tab view:
 *   Research Agent  — fan-out parallel sub-agents → Claude synthesis
 *   Pipeline        — 3-phase sequential research (Analyst→Quant→Strategist) [open-team pattern]
 *   Task Scheduler  — view / trigger / toggle background jobs
 *   Telemetry       — run history with timing + model info [open-team pattern]
 */

import { useState } from 'react'
import { Network, Calendar, GitBranch, BarChart2 } from 'lucide-react'
import ResearchAgentTab from './tabs/ResearchAgentTab'
import PipelineTab      from './tabs/PipelineTab'
import SchedulerTab     from './tabs/SchedulerTab'
import TelemetryTab     from './tabs/TelemetryTab'

// ── Root view ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'research',  label: 'Research Agent',   icon: Network   },
  { id: 'pipeline',  label: 'Pipeline',         icon: GitBranch },
  { id: 'scheduler', label: 'Task Scheduler',   icon: Calendar  },
  { id: 'telemetry', label: 'Telemetry',        icon: BarChart2 },
]

export default function AgentHubView() {
  const [tab, setTab] = useState('research')

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <Network className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Agent Hub</h1>
          <p className="text-xs text-slate-500">Multi-agent research · 3-phase pipeline · Scheduled tasks · Run telemetry</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all whitespace-nowrap ${
                tab === t.id ? 'border-mint-500 text-mint-400' : 'border-transparent text-slate-400 hover:text-white'
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'research'  && <ResearchAgentTab />}
      {tab === 'pipeline'  && <PipelineTab />}
      {tab === 'scheduler' && <SchedulerTab />}
      {tab === 'telemetry' && <TelemetryTab />}
    </div>
  )
}
