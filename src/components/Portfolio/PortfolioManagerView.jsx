/**
 * PortfolioManagerView — full management page for multi-portfolio setup.
 * Shown when user clicks "Manage" from the AccountSwitcher or navigates to the 'portfolios' tab.
 */
import { useState } from 'react'
import {
  Plus, Star, StarOff, Trash2, Pencil, Loader2,
  TrendingUp, Wallet, Shield, AlertTriangle,
  Globe, Lock, Users, Share2, ChevronDown, ChevronUp,
} from 'lucide-react'
import { usePortfolioContext, PORTFOLIO_TYPE_ICONS, PORTFOLIO_TYPE_LABELS } from '../../contexts/PortfolioContext'
import CreatePortfolioModal from './CreatePortfolioModal'
import PortfolioVisibilityToggle from './PortfolioVisibilityToggle'
import PortfolioShareModal from './PortfolioShareModal'

function StatCard({ label, value, sub, accent = '#00ffcc' }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color: accent }}>{value}</div>
      {sub && <div className="text-xs text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// Visibility badge shown on card
const VIS_MAP = {
  public:         { Icon: Globe,  label: 'Public',      color: '#00ffcc' },
  followers_only: { Icon: Users,  label: 'Shared',      color: '#6366f1' },
  private:        { Icon: Lock,   label: 'Private',     color: '#64748b' },
}

function PortfolioCard({ p, onEdit, onDelete, onSetDefault, isDeleting, isSettingDefault }) {
  const icon  = PORTFOLIO_TYPE_ICONS[p.type]  ?? '◉'
  const label = PORTFOLIO_TYPE_LABELS[p.type] ?? p.type
  const vis   = VIS_MAP[p.visibility] || VIS_MAP.private

  const [showSettings, setShowSettings] = useState(false)
  const [showShare,    setShowShare]    = useState(false)
  const [localPortfolio, setLocalPortfolio] = useState(p)

  // Merge updated visibility/copy_trade back into local state
  const handleVisUpdated = (patch) => {
    setLocalPortfolio(prev => ({ ...prev, ...patch }))
  }

  return (
    <>
      <div
        className="rounded-xl border transition-all"
        style={{
          background: localPortfolio.is_default ? `${localPortfolio.color}08` : 'rgba(255,255,255,0.02)',
          borderColor: localPortfolio.is_default ? `${localPortfolio.color}40` : 'rgba(255,255,255,0.06)',
        }}
      >
        {/* Card header */}
        <div className="p-4">
          <div className="flex items-start gap-3">
            {/* Icon blob */}
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
              style={{ background: `${localPortfolio.color}20` }}
            >
              {icon}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-white text-sm truncate">{localPortfolio.name}</span>
                {localPortfolio.is_default && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#00ffcc]/15 text-[#00ffcc] font-medium">
                    default
                  </span>
                )}
                {/* Visibility badge */}
                <span
                  className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{
                    color: vis.color,
                    background: `${vis.color}15`,
                    border: `1px solid ${vis.color}25`,
                  }}
                >
                  <vis.Icon size={9} />
                  {vis.label}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">{label}{localPortfolio.custodian ? ` · ${localPortfolio.custodian}` : ''}</div>
              {localPortfolio.description && (
                <div className="text-xs text-slate-600 mt-1 line-clamp-1">{localPortfolio.description}</div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0">
              {/* Set default */}
              <button
                onClick={() => onSetDefault(localPortfolio.id)}
                disabled={localPortfolio.is_default || isSettingDefault}
                title={localPortfolio.is_default ? 'Default portfolio' : 'Set as default'}
                className={`p-1.5 rounded-lg transition-colors
                  ${localPortfolio.is_default
                    ? 'text-[#00ffcc] cursor-default'
                    : 'text-slate-600 hover:text-yellow-400 hover:bg-yellow-400/10'
                  }`}
              >
                {isSettingDefault
                  ? <Loader2 size={14} className="animate-spin" />
                  : localPortfolio.is_default ? <Star size={14} fill="currentColor" /> : <StarOff size={14} />
                }
              </button>

              {/* Share */}
              <button
                onClick={() => setShowShare(true)}
                title="Share / manage access"
                className="p-1.5 rounded-lg text-slate-600 hover:text-[#6366f1] hover:bg-[#6366f1]/10 transition-colors"
              >
                <Share2 size={14} />
              </button>

              {/* Edit */}
              <button
                onClick={() => onEdit(localPortfolio)}
                title="Edit portfolio"
                className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-white/5 transition-colors"
              >
                <Pencil size={14} />
              </button>

              {/* Delete */}
              <button
                onClick={() => onDelete(localPortfolio.id)}
                disabled={localPortfolio.is_default || isDeleting}
                title={localPortfolio.is_default ? 'Cannot delete default portfolio' : 'Archive portfolio'}
                className={`p-1.5 rounded-lg transition-colors
                  ${localPortfolio.is_default
                    ? 'text-slate-700 cursor-not-allowed'
                    : 'text-slate-600 hover:text-red-400 hover:bg-red-500/10'
                  }`}
              >
                {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          </div>

          {/* Footer stats */}
          <div className="mt-3 pt-3 border-t border-white/[0.05] flex gap-4 text-xs text-slate-500">
            <span>
              <span className="text-slate-400 font-medium">{localPortfolio.holdingCount ?? 0}</span> holdings
            </span>
            {localPortfolio.cashBalance > 0 && (
              <span>
                <span className="text-slate-400 font-medium">${localPortfolio.cashBalance.toLocaleString()}</span> cash
              </span>
            )}
            <span className="ml-auto capitalize">{localPortfolio.tax_status?.replace('_', ' ') ?? '—'}</span>

            {/* Toggle visibility panel */}
            <button
              onClick={() => setShowSettings(v => !v)}
              className="flex items-center gap-1 text-slate-500 hover:text-slate-300 transition-colors ml-2"
            >
              <Globe size={11} />
              <span>Visibility</span>
              {showSettings ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          </div>
        </div>

        {/* Collapsible visibility panel */}
        {showSettings && (
          <div className="px-4 pb-4 pt-1 border-t border-white/[0.04]">
            <PortfolioVisibilityToggle
              portfolio={localPortfolio}
              onUpdated={handleVisUpdated}
            />
          </div>
        )}
      </div>

      {/* Share modal */}
      {showShare && (
        <PortfolioShareModal
          portfolio={localPortfolio}
          onClose={() => setShowShare(false)}
        />
      )}
    </>
  )
}

export default function PortfolioManagerView() {
  const {
    portfolios, loadingPortfolios, portfolioError,
    deletePortfolio, setDefaultPortfolio,
  } = usePortfolioContext()

  const [showCreate,   setShowCreate]   = useState(false)
  const [editTarget,   setEditTarget]   = useState(null)   // portfolio object being edited
  const [deletingId,   setDeletingId]   = useState(null)
  const [defaultingId, setDefaultingId] = useState(null)
  const [confirmDel,   setConfirmDel]   = useState(null)   // id awaiting confirm
  const [actionError,  setActionError]  = useState('')

  const totalHoldings = portfolios.reduce((s, p) => s + (p.holdingCount ?? 0), 0)
  const totalCash     = portfolios.reduce((s, p) => s + (p.cashBalance  ?? 0), 0)

  const handleDelete = async (id) => {
    if (confirmDel !== id) { setConfirmDel(id); return }
    setConfirmDel(null)
    setDeletingId(id)
    setActionError('')
    try {
      await deletePortfolio(id)
    } catch (err) {
      setActionError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  const handleSetDefault = async (id) => {
    setDefaultingId(id)
    setActionError('')
    try {
      await setDefaultPortfolio(id)
    } catch (err) {
      setActionError(err.message)
    } finally {
      setDefaultingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Portfolio Accounts</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage your investment accounts and portfolios
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00ffcc] text-[#0a0e1a]
                     text-sm font-semibold hover:bg-[#00e6b8] transition-colors"
        >
          <Plus size={15} />
          New Portfolio
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Portfolios"    value={portfolios.length}              />
        <StatCard label="Total Holdings" value={totalHoldings}                 />
        <StatCard label="Total Cash"    value={`$${totalCash.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`} accent="#f59e0b" />
        <StatCard label="Account Types" value={new Set(portfolios.map(p => p.type)).size} accent="#8b5cf6" />
      </div>

      {/* Error banner */}
      {(portfolioError || actionError) && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          <AlertTriangle size={13} />
          {portfolioError || actionError}
        </div>
      )}

      {/* Confirm delete banner */}
      {confirmDel && (
        <div className="flex items-center justify-between gap-4 p-3 rounded-lg
                        bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs">
          <span className="flex items-center gap-2">
            <AlertTriangle size={13} />
            Archive this portfolio? Holdings will be preserved but hidden. Click delete again to confirm.
          </span>
          <button
            onClick={() => setConfirmDel(null)}
            className="shrink-0 text-slate-500 hover:text-slate-300"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Portfolio cards */}
      {loadingPortfolios ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-[#00ffcc]" />
        </div>
      ) : portfolios.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
          <Wallet size={40} className="text-slate-700" />
          <div>
            <p className="text-slate-400 font-medium">No portfolios yet</p>
            <p className="text-slate-600 text-sm mt-1">Create your first portfolio to get started</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#00ffcc] text-[#0a0e1a]
                       text-sm font-semibold hover:bg-[#00e6b8] transition-colors"
          >
            <Plus size={15} />
            Create Portfolio
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {portfolios.map(p => (
            <PortfolioCard
              key={p.id}
              p={p}
              onEdit={setEditTarget}
              onDelete={handleDelete}
              onSetDefault={handleSetDefault}
              isDeleting={deletingId === p.id}
              isSettingDefault={defaultingId === p.id}
            />
          ))}
        </div>
      )}

      {/* Tips */}
      <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] p-4">
        <div className="flex items-start gap-3">
          <Shield size={16} className="text-[#00ffcc] shrink-0 mt-0.5" />
          <div className="text-xs text-slate-500 space-y-1">
            <p className="text-slate-400 font-medium">Portfolio tips</p>
            <p>Each portfolio has its own holdings, performance tracking, and P&L calculations.</p>
            <p>The <span className="text-[#00ffcc]">default</span> portfolio is selected automatically on login.</p>
            <p>Archiving a portfolio hides it but preserves all data.</p>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreatePortfolioModal onClose={() => setShowCreate(false)} />
      )}
      {editTarget && (
        <CreatePortfolioModal
          portfolio={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  )
}
