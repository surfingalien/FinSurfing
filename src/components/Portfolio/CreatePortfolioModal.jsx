/**
 * CreatePortfolioModal — modal to create (or edit) a portfolio.
 * Pass `portfolio` prop to edit an existing one; omit for creation.
 */
import { useState, useEffect } from 'react'
import { X, Loader2 } from 'lucide-react'
import { usePortfolioContext, PORTFOLIO_TYPE_LABELS, PORTFOLIO_TYPE_ICONS } from '../../contexts/PortfolioContext'

const COLORS = [
  '#6366f1', '#00ffcc', '#f59e0b', '#ef4444', '#8b5cf6',
  '#10b981', '#3b82f6', '#f97316', '#ec4899', '#06b6d4',
]

const TAX_OPTIONS = [
  { value: 'taxable',     label: 'Taxable' },
  { value: 'tax_deferred',label: 'Tax-Deferred (Traditional IRA, 401k…)' },
  { value: 'tax_free',    label: 'Tax-Free (Roth IRA, HSA…)' },
]

export default function CreatePortfolioModal({ onClose, portfolio: existing }) {
  const { createPortfolio, updatePortfolio } = usePortfolioContext()
  const isEdit = !!existing

  const [form, setForm] = useState({
    name:        existing?.name        ?? '',
    type:        existing?.type        ?? 'brokerage',
    description: existing?.description ?? '',
    custodian:   existing?.custodian   ?? '',
    cashBalance: existing?.cashBalance ?? 0,
    color:       existing?.color       ?? COLORS[0],
    taxStatus:   existing?.tax_status  ?? 'taxable',
    currency:    existing?.currency    ?? 'USD',
  })
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // Trap Escape
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.name.trim()) return setError('Portfolio name is required')
    setLoading(true)
    try {
      if (isEdit) {
        await updatePortfolio(existing.id, form)
      } else {
        await createPortfolio(form)
      }
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0f1117] border border-white/10 shadow-2xl shadow-black/60 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-white">
            {isEdit ? 'Edit Portfolio' : 'Create Portfolio'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={submit} className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              {error}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Portfolio Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Main Brokerage"
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600 focus:outline-none
                         focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/20 transition-all"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Account Type</label>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(PORTFOLIO_TYPE_LABELS).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => set('type', val)}
                  className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg border text-center transition-all
                    ${form.type === val
                      ? 'border-[#00ffcc]/50 bg-[#00ffcc]/10 text-[#00ffcc]'
                      : 'border-white/[0.06] bg-white/[0.02] text-slate-400 hover:border-white/20'
                    }`}
                >
                  <span className="text-lg leading-none">{PORTFOLIO_TYPE_ICONS[val]}</span>
                  <span className="text-[10px] leading-tight">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Tax Status */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Tax Treatment</label>
            <select
              value={form.taxStatus}
              onChange={e => set('taxStatus', e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white focus:outline-none focus:border-[#00ffcc]/40
                         focus:ring-1 focus:ring-[#00ffcc]/20 transition-all"
            >
              {TAX_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Custodian */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Broker / Custodian</label>
            <input
              type="text"
              value={form.custodian}
              onChange={e => set('custodian', e.target.value)}
              placeholder="e.g. Fidelity, Schwab, Coinbase…"
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600 focus:outline-none
                         focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/20 transition-all"
            />
          </div>

          {/* Cash Balance */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Cash Balance ($)</label>
            <input
              type="number"
              value={form.cashBalance}
              onChange={e => set('cashBalance', parseFloat(e.target.value) || 0)}
              min={0}
              step="0.01"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white focus:outline-none focus:border-[#00ffcc]/40
                         focus:ring-1 focus:ring-[#00ffcc]/20 transition-all"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Description (optional)</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Notes about this portfolio…"
              maxLength={500}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08]
                         text-sm text-white placeholder-slate-600 resize-none focus:outline-none
                         focus:border-[#00ffcc]/40 focus:ring-1 focus:ring-[#00ffcc]/20 transition-all"
            />
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Color</label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('color', c)}
                  className={`w-7 h-7 rounded-full transition-all ${form.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0f1117]' : ''}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.06] flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200
                       hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold
                       bg-[#00ffcc] text-[#0a0e1a] hover:bg-[#00e6b8] transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {isEdit ? 'Save Changes' : 'Create Portfolio'}
          </button>
        </div>
      </div>
    </div>
  )
}
