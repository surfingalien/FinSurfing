/**
 * MacroView — full-page macro economic dashboard.
 * Route id: 'macro'
 */
import MacroPanel from './MacroPanel'
import { Globe } from 'lucide-react'

export default function MacroView() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
          <Globe className="w-5 h-5 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Macro Dashboard</h1>
          <p className="text-xs text-slate-500">Key FRED macroeconomic indicators with AI regime assessment</p>
        </div>
      </div>
      <MacroPanel />
    </div>
  )
}
