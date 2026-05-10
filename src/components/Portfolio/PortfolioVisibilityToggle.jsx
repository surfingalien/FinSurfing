/**
 * PortfolioVisibilityToggle — inline visibility + copy-trade controls.
 */
import { useState } from 'react'
import { Lock, Globe, Users, Copy, Loader2, CheckCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { usePortfolioContext } from '../../contexts/PortfolioContext'

const OPTIONS = [
  { value: 'private',        label: 'Private',   Icon: Lock,  color: '#64748b',
    desc: 'Only you can see this portfolio' },
  { value: 'public',         label: 'Public',    Icon: Globe, color: '#00ffcc',
    desc: 'Discoverable by anyone (cost basis hidden)' },
  { value: 'followers_only', label: 'Followers', Icon: Users, color: '#6366f1',
    desc: 'Only users you share with directly' },
]

export default function PortfolioVisibilityToggle({ portfolio, onUpdated }) {
  const { authFetch }      = useAuth()
  const { fetchPortfolios } = usePortfolioContext()

  const [vis,       setVis]       = useState(portfolio.visibility || 'private')
  const [copyTrade, setCopyTrade] = useState(!!portfolio.copy_trade_enabled)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState('')

  const save = async (newVis, newCopyTrade) => {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const res  = await authFetch(`/api/portfolios/${portfolio.id}/visibility`, {
        method: 'PATCH',
        body:   { visibility: newVis, copyTradeEnabled: newCopyTrade },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      await fetchPortfolios()
      onUpdated?.({ visibility: newVis, copy_trade_enabled: newCopyTrade })
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleVis = (v) => { setVis(v);           save(v, copyTrade)   }
  const handleCT  = ()  => { const n = !copyTrade; setCopyTrade(n); save(vis, n) }

  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-slate-400">Portfolio Visibility</label>

      <div className="space-y-2">
        {OPTIONS.map(({ value, label, Icon, color, desc }) => {
          const sel = vis === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleVis(value)}
              disabled={saving}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all"
              style={sel
                ? { borderColor: `${color}50`, background: `${color}0D`, color }
                : { borderColor: 'rgba(255,255,255,0.06)', color: '#94a3b8' }
              }
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all"
                style={{ background: sel ? `${color}20` : 'rgba(255,255,255,0.04)' }}>
                <Icon size={14} style={{ color: sel ? color : '#64748b' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold">{label}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{desc}</div>
              </div>
              {sel && <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
            </button>
          )
        })}
      </div>

      {/* Copy trade — only when public */}
      {vis === 'public' && (
        <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <Copy size={13} className="text-slate-500" />
            <div>
              <p className="text-xs font-medium text-slate-300">Allow Copy Trading</p>
              <p className="text-[10px] text-slate-600">Others can replicate this portfolio as their own</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCT}
            disabled={saving}
            aria-checked={copyTrade}
            role="switch"
            className={`relative w-10 h-5 rounded-full transition-colors duration-200 focus:outline-none
              ${copyTrade ? 'bg-[#00ffcc]' : 'bg-white/10'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200
              ${copyTrade ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}

      {/* Public portfolio link */}
      {vis === 'public' && portfolio.ownerUsername && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#00ffcc]/5 border border-[#00ffcc]/15">
          <Globe size={11} className="text-[#00ffcc] shrink-0" />
          <span className="text-[10px] text-slate-400 flex-1 truncate">
            Public URL: <span className="text-[#00ffcc] font-mono">
              /user/{portfolio.ownerUsername}/portfolio
            </span>
          </span>
        </div>
      )}

      {/* Status row */}
      <div className="h-4 flex items-center px-1">
        {saving && <span className="flex items-center gap-1.5 text-[11px] text-slate-500"><Loader2 size={10} className="animate-spin" />Saving…</span>}
        {!saving && saved && <span className="flex items-center gap-1.5 text-[11px] text-emerald-400"><CheckCircle size={10} />Saved</span>}
        {!saving && error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  )
}
