/**
 * PortfolioShareModal — grant view or copy-trade access to specific users.
 */
import { useState, useEffect } from 'react'
import { X, UserPlus, Trash2, Loader2, Globe, Lock, Users, Copy, AlertTriangle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const PERM_LABELS = { view: 'View Only', copy_trade: 'Copy Trading' }

function ShareRow({ share, onRevoke, revoking }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.05]">
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#00ffcc]/30 to-[#6366f1]/30
                      flex items-center justify-center text-xs font-bold text-slate-300 shrink-0">
        {(share.username || share.email || '?')[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-slate-200 truncate">
          {share.username ? `@${share.username}` : share.email}
        </p>
        <p className="text-[10px] text-slate-500">{PERM_LABELS[share.permission] || share.permission}</p>
      </div>
      {share.expires_at && (
        <span className="text-[10px] text-slate-600">
          Exp {new Date(share.expires_at).toLocaleDateString()}
        </span>
      )}
      <button
        onClick={() => onRevoke(share.id)}
        disabled={revoking === share.id}
        className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
      >
        {revoking === share.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
      </button>
    </div>
  )
}

export default function PortfolioShareModal({ portfolio, onClose }) {
  const { authFetch } = useAuth()

  const [shares,     setShares]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [revoking,   setRevoking]   = useState(null)
  const [addTarget,  setAddTarget]  = useState('')  // username or email
  const [addPerm,    setAddPerm]    = useState('view')
  const [addExpiry,  setAddExpiry]  = useState('')
  const [adding,     setAdding]     = useState(false)
  const [addError,   setAddError]   = useState('')

  // Escape key
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  // Load shares
  useEffect(() => {
    loadShares()
  }, [])

  const loadShares = async () => {
    setLoading(true)
    try {
      const res  = await authFetch(`/api/portfolios/${portfolio.id}/shares`)
      const data = await res.json()
      if (res.ok) setShares(data.shares || data || [])
    } catch {}
    finally { setLoading(false) }
  }

  const addShare = async (e) => {
    e.preventDefault()
    if (!addTarget.trim()) return setAddError('Enter a username or email')
    setAdding(true)
    setAddError('')
    try {
      const body = { target: addTarget.trim(), permission: addPerm }
      if (addExpiry) body.expiresAt = new Date(addExpiry).toISOString()
      const res  = await authFetch(`/api/portfolios/${portfolio.id}/shares`, {
        method: 'POST', body,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to share')
      setAddTarget('')
      setAddExpiry('')
      await loadShares()
    } catch (err) {
      setAddError(err.message)
    } finally {
      setAdding(false)
    }
  }

  const revokeShare = async (shareId) => {
    setRevoking(shareId)
    try {
      await authFetch(`/api/portfolios/${portfolio.id}/shares/${shareId}`, { method: 'DELETE' })
      setShares(s => s.filter(sh => sh.id !== shareId))
    } catch {}
    finally { setRevoking(null) }
  }

  const visIcon = { private: Lock, public: Globe, followers_only: Users }[portfolio.visibility] || Lock
  const VisIcon = visIcon

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0f1117] border border-white/10 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Share Portfolio</h2>
            <p className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
              <VisIcon size={10} />
              {portfolio.name} · {portfolio.visibility}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/5 transition-all">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Add new share */}
          <form onSubmit={addShare} className="space-y-3">
            <label className="block text-xs font-medium text-slate-400">Grant access to a user</label>

            {addError && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                <AlertTriangle size={12} />
                {addError}
              </div>
            )}

            <input
              value={addTarget}
              onChange={e => setAddTarget(e.target.value)}
              placeholder="username or email address"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600 focus:outline-none
                         focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/15 transition-all"
            />

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">Permission</label>
                <select
                  value={addPerm}
                  onChange={e => setAddPerm(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                             text-xs text-white focus:outline-none focus:border-[#00ffcc]/40 transition-all"
                >
                  <option value="view">View Only</option>
                  <option value="copy_trade">Copy Trading</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">Expires (optional)</label>
                <input
                  type="date"
                  value={addExpiry}
                  onChange={e => setAddExpiry(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full px-2.5 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                             text-xs text-white focus:outline-none focus:border-[#00ffcc]/40 transition-all"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={adding || !addTarget.trim()}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg
                         text-xs font-semibold text-[#0a0e1a] bg-[#00ffcc] hover:bg-[#00e6b8]
                         disabled:opacity-40 transition-all"
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Grant Access
            </button>
          </form>

          {/* Existing shares */}
          <div>
            <p className="text-xs font-medium text-slate-400 mb-2">
              Current access ({shares.length})
            </p>
            {loading ? (
              <div className="flex justify-center py-4">
                <Loader2 size={18} className="animate-spin text-slate-600" />
              </div>
            ) : shares.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4">
                No one has been granted access yet
              </p>
            ) : (
              <div className="space-y-2">
                {shares.map(s => (
                  <ShareRow key={s.id} share={s} onRevoke={revokeShare} revoking={revoking} />
                ))}
              </div>
            )}
          </div>

          {/* Copy-trade note */}
          {portfolio.copy_trade_enabled && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-xs text-slate-400">
              <Copy size={12} className="text-[#6366f1] shrink-0 mt-0.5" />
              Copy trading is enabled. Anyone viewing this public portfolio can replicate it.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
