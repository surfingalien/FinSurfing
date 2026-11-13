/**
 * QuantLab — the quant toolbox in one place: option pricing, portfolio optimisers, volatility models, time-series
 * diagnostics, pairs and stat-arb, risk statistics, a machine-learning comparison bench, a scan of the user's own holdings with all of them, relative-value
 * calculators and a linked quant reference. Every tool is deterministic maths (lib/quant/*); no language model is
 * involved. Pure-maths tools work for guests; tools that need market data ask for a sign-in.
 */
import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { OptionsTab, PortfolioTab, VolatilityTab, SeriesTab, StrategiesTab, RiskTab, ModelsTab, CalculatorsTab } from './tabs'
import LearnTab from './LearnTab'
import DiscoveryTab from './DiscoveryTab'
import HoldingsTab from './HoldingsTab'
import StrategyBrainTab from './StrategyBrainTab'
import EventStudyTab from './EventStudyTab'
import { QUANT_TABS } from './reference'

const TABS = [
  ['holdings', 'My holdings', HoldingsTab], ['brain', 'Strategy Brain', StrategyBrainTab], ['options', 'Options', OptionsTab], ['portfolio', 'Portfolio', PortfolioTab], ['vol', 'Volatility', VolatilityTab], ['series', 'Time series', SeriesTab], ['events', 'Event study', EventStudyTab],
  ['strategies', 'Strategies', StrategiesTab], ['risk', 'Risk', RiskTab], ['models', 'ML models', ModelsTab], ['calculators', 'Calculators', CalculatorsTab], ['discovery', 'Discovery', DiscoveryTab], ['learn', 'Learn', LearnTab],
]

export default function QuantLabView({ section, positions = [] }) {
  const [tab, setTab] = useState(QUANT_TABS.includes(section) ? section : 'holdings')
  useEffect(() => { if (QUANT_TABS.includes(section)) setTab(section) }, [section])
  const pick = id => { setTab(id); window.history.replaceState(null, '', `#/quant-lab/${id}`) }
  const Active = TABS.find(t => t[0] === tab)[2]
  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      <header className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-mint-400/10 border border-mint-400/25 flex items-center justify-center"><FlaskConical className="w-5 h-5 text-mint-400" /></div>
        <div>
          <h1 className="text-xl font-bold text-white">Quant Lab</h1>
          <p className="text-xs text-slate-400 mt-0.5">Pricing, optimisation, volatility, time-series, risk and machine-learning tools, plus the discovery lists the AI Brain scans draw from — all deterministic maths, tested, and judged out of sample. Not investment advice.</p>
        </div>
      </header>
      <nav className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Quant Lab sections">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => pick(id)} aria-current={tab === id ? 'page' : undefined}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap border ${tab === id ? 'bg-mint-400/15 text-mint-400 border-mint-400/30' : 'text-slate-400 border-slate-500/20 hover:text-white'}`}>{label}</button>
        ))}
      </nav>
      <Active positions={positions} />
    </div>
  )
}
