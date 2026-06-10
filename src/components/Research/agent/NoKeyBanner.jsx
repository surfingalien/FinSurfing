import { Info } from 'lucide-react'

// ── No API key banner ─────────────────────────────────────────────────────────

export function NoKeyBanner() {
  return (
    <div className="glass rounded-xl p-6 border border-amber-500/20 flex items-start gap-4">
      <Info className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-semibold text-white mb-1">Anthropic API Key Required</p>
        <p className="text-xs text-slate-400 leading-relaxed">
          The AI Agent requires an <code className="font-mono text-mint-300 bg-white/5 px-1 rounded">ANTHROPIC_API_KEY</code> environment variable.
          Add it to your Railway service variables, then redeploy.
        </p>
        <p className="text-xs text-slate-500 mt-2">
          Get your key at <span className="text-mint-400">console.anthropic.com</span>
        </p>
      </div>
    </div>
  )
}
