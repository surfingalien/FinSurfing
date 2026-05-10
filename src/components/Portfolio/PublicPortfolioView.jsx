/**
 * PublicPortfolioView — sanitized read-only view of a public portfolio.
 * Shown via /api/public/portfolios/:id or /api/public/users/:username/portfolio.
 * Cost basis, cash balance, and personal notes are never shown.
 */
import { useState, useEffect } from 'react'
import {
  Globe, TrendingUp, TrendingDown, Copy, Users, Lock,
  Loader2, AlertTriangle, BarChart2, PieChart, ExternalLink,
  RefreshCw, Eye,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const BASE = import.meta.env.VITE_API_URL || ''

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  const v = Number(n)
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}
function fmtK(n) {
  if (n == null || isNaN(n)) return '—'
  const v = Math.abs(Number(n))
  if (v >= 1e9) return '$' + (Number(n) / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return '$' + (Number(n) / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return '$' + (Number(n) / 1e3).toFixed(1) + 'K'
  return '$' + fmt(n)
}

// ── Sub-components ────────────────────────────────────────────────────────────
function VisibilityBadge({ visibility }) {
  const map = {
    public:         { Icon: Globe,  label: 'Public',      color: '#00ffcc' },
    followers_only: { Icon: Users,  label: 'Shared',      color: '#6366f1' },
    private:        { Icon: Lock,   label: 'Private',     color: '#64748b' },
  }
  const { Icon, label, color } = map[visibility] || map.private
  return (
    <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
      style={{ color, background: `${color}20`, border: `1px solid ${color}30` }}>
      <Icon size={9} />
      {label}
    </span>
  )
}

function StatPill({ label, value, accent = '#00ffcc', up }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className="text-lg font-bold" style={{ color: up == null ? accent : up ? '#10b981' : '#ef4444' }}>
        {value}
      </div>
    </div>
  )
}

function HoldingRow({ h, rank }) {
  const up = (h.unrealized_gain_pct ?? h.change_pct ?? 0) >= 0
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.04]
                    hover:border-white/[0.08] hover:bg-white/[0.04] transition-all">
      {/* Rank */}
      <span className="w-5 text-[10px] text-slate-600 text-right shrink-0">{rank}</span>

      {/* Ticker + name */}
      <div className="w-14 shrink-0">
        <div className="text-sm font-bold text-white font-mono">{h.symbol}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-400 truncate">{h.name || h.symbol}</div>
      </div>

      {/* Shares */}
      <div className="hidden sm:block text-right shrink-0 w-20">
        <div className="text-xs text-slate-500">{fmt(h.shares, 4)} sh</div>
      </div>

      {/* Market value */}
      <div className="text-right shrink-0 w-24">
        <div className="text-xs font-medium text-white">{fmtK(h.market_value)}</div>
        {h.weight_pct != null && (
          <div className="text-[10px] text-slate-600">{fmt(h.weight_pct, 1)}%</div>
        )}
      </div>

      {/* P/L % */}
      <div className="text-right shrink-0 w-20">
        <div className={`text-xs font-semibold flex items-center justify-end gap-0.5
          ${up ? 'text-emerald-400' : 'text-red-400'}`}>
          {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          {fmtPct(h.unrealized_gain_pct ?? h.change_pct)}
        </div>
      </div>
    </div>
  )
}

function WeightBar({ holdings }) {
  if (!holdings?.length) return null
  // Use top 8 by weight
  const sorted = [...holdings].sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0)).slice(0, 8)
  const COLORS = ['#00ffcc', '#6366f1', '#f59e0b', '#10b981', '#ec4899', '#3b82f6', '#8b5cf6', '#f97316']
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-px">
        {sorted.map((h, i) => (
          <div
            key={h.symbol}
            style={{ width: `${Math.max(h.weight_pct || 0, 1)}%`, background: COLORS[i] }}
            title={`${h.symbol}: ${fmt(h.weight_pct, 1)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {sorted.map((h, i) => (
          <span key={h.symbol} className="flex items-center gap-1 text-[10px] text-slate-400">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[i] }} />
            {h.symbol} {fmt(h.weight_pct, 1)}%
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PublicPortfolioView({ portfolioId, username, onClose }) {
  const { authFetch } = useAuth()

  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [copied,  setCopied]  = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      // Prefer username-based URL; fall back to ID
      const url = username
        ? `${BASE}/api/public/users/${encodeURIComponent(username)}/portfolio`
        : `${BASE}/api/public/portfolios/${portfolioId}`

      // Try authenticated fetch first (for shared/private), fall back to plain
      let res
      try {
        res = await authFetch(url)
      } catch {
        res = await fetch(url)
      }
      if (res.status === 404) throw new Error('Portfolio not found or not public')
      if (res.status === 429) throw new Error('Too many requests — please wait a moment')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [portfolioId, username])

  const copyLink = () => {
    const url = username
      ? `${window.location.origin}/user/${username}/portfolio`
      : `${window.location.origin}/portfolio/${portfolioId}`
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-[#00ffcc]" />
      </div>
    )
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <AlertTriangle size={36} className="text-red-400" />
        <div>
          <p className="text-slate-300 font-medium text-sm">{error}</p>
          <p className="text-slate-600 text-xs mt-1">This portfolio may be private or no longer shared.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={load}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs text-slate-400
                       hover:text-white border border-white/[0.08] hover:bg-white/5 transition-all"
          >
            <RefreshCw size={12} />
            Retry
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs text-slate-400
                         hover:text-white border border-white/[0.08] hover:bg-white/5 transition-all"
            >
              Close
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!data) return null

  const { portfolio, holdings = [], disclaimer } = data
  const totalValue  = holdings.reduce((s, h) => s + (h.market_value || 0), 0)
  const gainers     = holdings.filter(h => (h.unrealized_gain_pct ?? h.change_pct ?? 0) > 0).length
  const losers      = holdings.length - gainers
  const portfolioUp = (portfolio.total_gain_pct ?? 0) >= 0

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-white">{portfolio.name}</h1>
            <VisibilityBadge visibility={portfolio.visibility} />
            {portfolio.copy_trade_enabled && (
              <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full
                               text-[#6366f1] bg-[#6366f1]/10 border border-[#6366f1]/20">
                <Copy size={9} />
                Copy Trade
              </span>
            )}
          </div>
          {portfolio.owner_username && (
            <p className="text-xs text-slate-500 mt-1">
              by <span className="text-slate-400 font-medium">@{portfolio.owner_username}</span>
            </p>
          )}
          {portfolio.description && (
            <p className="text-sm text-slate-400 mt-2 max-w-prose">{portfolio.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/5
                       border border-white/[0.06] transition-all"
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={copyLink}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-all
                       text-slate-400 hover:text-white border-white/[0.08] hover:bg-white/5"
          >
            {copied ? <span className="text-emerald-400">Copied!</span> : (
              <><ExternalLink size={12} /> Share Link</>
            )}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-white
                         border border-white/[0.06] hover:bg-white/5 transition-all"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Privacy notice ─────────────────────────────────────────────────── */}
      {disclaimer && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20">
          <Eye size={12} className="text-[#6366f1] shrink-0 mt-0.5" />
          <p className="text-[11px] text-slate-400">{disclaimer}</p>
        </div>
      )}

      {/* ── Stats row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatPill
          label="Portfolio Value"
          value={fmtK(portfolio.total_value ?? totalValue)}
        />
        <StatPill
          label="Total Return"
          value={fmtPct(portfolio.total_gain_pct)}
          up={portfolioUp}
        />
        <StatPill label="Holdings"   value={holdings.length}  accent="#8b5cf6" />
        <StatPill label="Gainers / Losers"
          value={`${gainers} / ${losers}`}
          accent={gainers >= losers ? '#10b981' : '#ef4444'}
        />
      </div>

      {/* ── Allocation bar ─────────────────────────────────────────────────── */}
      {holdings.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <PieChart size={13} className="text-slate-500" />
            <span className="text-xs font-medium text-slate-400">Allocation</span>
          </div>
          <WeightBar holdings={holdings} />
        </div>
      )}

      {/* ── Holdings table ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-4">
          <BarChart2 size={13} className="text-slate-500" />
          <span className="text-xs font-medium text-slate-400">Holdings ({holdings.length})</span>
          <span className="ml-auto text-[10px] text-slate-600">Cost basis hidden</span>
        </div>

        {holdings.length === 0 ? (
          <div className="text-center py-10 text-slate-600 text-sm">No holdings to display</div>
        ) : (
          <div className="space-y-1.5">
            {/* Column headers */}
            <div className="flex items-center gap-3 px-4 text-[10px] text-slate-600">
              <span className="w-5" />
              <span className="w-14">Symbol</span>
              <span className="flex-1">Name</span>
              <span className="hidden sm:block w-20 text-right">Shares</span>
              <span className="w-24 text-right">Value</span>
              <span className="w-20 text-right">Return</span>
            </div>
            {holdings.map((h, i) => (
              <HoldingRow key={h.symbol || i} h={h} rank={i + 1} />
            ))}
          </div>
        )}
      </div>

      {/* ── Copy trade CTA ─────────────────────────────────────────────────── */}
      {portfolio.copy_trade_enabled && (
        <div className="rounded-xl border border-[#6366f1]/30 bg-[#6366f1]/10 p-4 flex items-start gap-3">
          <Copy size={16} className="text-[#6366f1] shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-white">Copy Trade Available</p>
            <p className="text-xs text-slate-400 mt-1">
              This portfolio allows copy trading. Contact the owner or use the share feature to replicate it.
            </p>
          </div>
        </div>
      )}

      {/* ── Footer disclaimer ───────────────────────────────────────────────── */}
      <div className="text-[10px] text-slate-700 text-center pb-2">
        Public portfolio data · Cost basis & personal notes hidden · Not financial advice
      </div>
    </div>
  )
}
