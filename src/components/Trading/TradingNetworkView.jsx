/**
 * TradingNetworkView.jsx
 *
 * All-in-one AI-Trader Network tab:
 *  • My Signals — published signals + stats
 *  • Notifications — follower/reply alerts
 *  • Leaderboard — top traders + follow/unfollow
 *
 * Phases 1–3 live here. Phase 4 (market context) is embedded in PublishSignalModal.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Users, Bell, TrendingUp, TrendingDown, Minus, Star,
  UserPlus, UserMinus, RefreshCw, Send, CheckCheck,
  Activity, Award, Zap, ChevronRight, AlertTriangle,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useAITrader } from '../../contexts/AITraderContext'
import {
  getLeaderboard, getFollowing, followTrader, unfollowTrader, getMySignals,
} from '../../services/aiTraderService'
import PublishSignalModal from './PublishSignalModal'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_COLOR = {
  buy:   'text-emerald-400',
  sell:  'text-red-400',
  short: 'text-orange-400',
  cover: 'text-slate-400',
}

const ACTION_ICON = {
  buy:   TrendingUp,
  sell:  TrendingDown,
  short: TrendingDown,
  cover: Minus,
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Sub-panel: My Signals ─────────────────────────────────────────────────────

function MySignalsPanel({ onPublish }) {
  const { status, refreshStatus } = useAITrader()
  const [signals, setSignals] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { signals: s } = await getMySignals()
      setSignals(s || [])
    } catch {} finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Signals', value: status?.signalCount ?? '—', icon: Send, color: 'mint' },
          { label: 'Unread',  value: status?.unreadCount  ?? '—', icon: Bell, color: 'amber' },
          { label: 'Status',  value: status?.registered ? 'Active' : 'Inactive', icon: Activity, color: status?.registered ? 'emerald' : 'slate' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="glass rounded-xl p-4 border border-white/[0.06]">
            <div className={`text-xs text-slate-500 mb-1`}>{label}</div>
            <div className={`text-lg font-bold font-mono
              ${color === 'mint' ? 'text-mint-400' : color === 'amber' ? 'text-amber-400' : color === 'emerald' ? 'text-emerald-400' : 'text-slate-400'}`}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Publish button */}
      <button onClick={onPublish}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
                   bg-mint-500/10 border border-mint-500/25 text-mint-400 text-sm font-semibold
                   hover:bg-mint-500/20 transition-all">
        <Send className="w-4 h-4" />
        Publish New Signal
      </button>

      {/* Signal history */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-5 h-5 text-slate-600 animate-spin" />
        </div>
      ) : signals.length === 0 ? (
        <div className="text-center py-10 text-slate-600 text-sm">
          No signals published yet.<br />
          <span className="text-xs">Publish your first signal from the AI Agent tab.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {signals.map(sig => {
            const Icon = ACTION_ICON[sig.action] || Minus
            return (
              <div key={sig.id} className="glass rounded-xl px-4 py-3 border border-white/[0.06] flex items-start gap-3">
                <div className={`mt-0.5 ${ACTION_COLOR[sig.action] || 'text-slate-400'}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-mono font-bold text-white">{sig.symbol}</span>
                    <span className={`text-xs font-bold uppercase ${ACTION_COLOR[sig.action] || 'text-slate-400'}`}>{sig.action}</span>
                    {sig.price && <span className="text-xs font-mono text-slate-400">${sig.price}</span>}
                    {sig.followers > 0 && (
                      <span className="ml-auto text-xs text-slate-500 flex items-center gap-1">
                        <Users className="w-3 h-3" />{sig.followers}
                      </span>
                    )}
                  </div>
                  {sig.analysis && (
                    <p className="text-xs text-slate-400 truncate">{sig.analysis.slice(0, 120)}</p>
                  )}
                  <div className="text-[10px] text-slate-600 mt-1">{timeAgo(sig.published_at)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sub-panel: Notifications ──────────────────────────────────────────────────

const NOTIF_META = {
  new_follower:             { label: 'New Follower',        icon: UserPlus,  color: 'mint' },
  discussion_reply:         { label: 'Reply to Signal',     icon: Bell,      color: 'indigo' },
  strategy_reply_accepted:  { label: 'Analysis Accepted',  icon: Award,     color: 'amber' },
  info:                     { label: 'Notification',        icon: Zap,       color: 'slate' },
}

function NotificationsPanel() {
  const { notifications, markRead, refreshNotifications } = useAITrader()
  const [marking, setMarking] = useState(false)

  async function handleMarkAll() {
    setMarking(true)
    try { await markRead() } finally { setMarking(false) }
  }

  const unread = notifications.filter(n => !n.is_read).length

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {unread > 0 ? `${unread} unread notification${unread > 1 ? 's' : ''}` : 'All caught up'}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={refreshNotifications}
            className="p-1.5 rounded-lg hover:bg-white/[0.05] text-slate-500 hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {unread > 0 && (
            <button onClick={handleMarkAll} disabled={marking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                         border border-white/[0.06] text-slate-400 hover:text-white transition-colors">
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
          )}
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="text-center py-12 text-slate-600 text-sm">
          No notifications yet.<br />
          <span className="text-xs">Publish a signal to start receiving follower alerts.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(n => {
            const meta  = NOTIF_META[n.type] || NOTIF_META.info
            const Icon  = meta.icon
            const data  = typeof n.data === 'string' ? JSON.parse(n.data) : n.data
            const colorMap = { mint: 'text-mint-400', indigo: 'text-indigo-400', amber: 'text-amber-400', slate: 'text-slate-400' }
            const bgMap    = { mint: 'bg-mint-500/8', indigo: 'bg-indigo-500/8', amber: 'bg-amber-500/8', slate: 'bg-slate-500/5' }

            return (
              <div key={n.id}
                className={`glass rounded-xl px-4 py-3 border transition-all
                  ${n.is_read ? 'border-white/[0.04] opacity-60' : 'border-white/[0.08]'}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${bgMap[meta.color]}`}>
                    <Icon className={`w-3.5 h-3.5 ${colorMap[meta.color]}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold ${colorMap[meta.color]}`}>{meta.label}</span>
                      {!n.is_read && <span className="w-1.5 h-1.5 rounded-full bg-mint-400" />}
                    </div>
                    {data?.content && (
                      <p className="text-xs text-slate-300 mt-0.5 line-clamp-2">{data.content}</p>
                    )}
                    {data?.follower_name && (
                      <p className="text-xs text-slate-400 mt-0.5">{data.follower_name} started following your signal</p>
                    )}
                    <div className="text-[10px] text-slate-600 mt-1">{timeAgo(n.created_at)}</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sub-panel: Leaderboard ────────────────────────────────────────────────────

function LeaderboardPanel({ onPublish }) {
  const [traders,   setTraders]   = useState([])
  const [following, setFollowing] = useState(new Set())
  const [loading,   setLoading]   = useState(true)
  const [toggling,  setToggling]  = useState(null)
  const { isAuthenticated } = useAuth()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [lb, fl] = await Promise.allSettled([
        getLeaderboard(30),
        isAuthenticated ? getFollowing() : Promise.resolve({ following: [] }),
      ])
      if (lb.status === 'fulfilled') setTraders(lb.value.traders || [])
      if (fl.status === 'fulfilled') setFollowing(new Set((fl.value.following || []).map(f => f.leader_id)))
    } finally { setLoading(false) }
  }, [isAuthenticated])

  useEffect(() => { load() }, [load])

  async function toggleFollow(trader) {
    if (!isAuthenticated) return
    setToggling(trader.id || trader.agent_id)
    try {
      const id = trader.id || trader.agent_id
      if (following.has(String(id))) {
        await unfollowTrader(String(id))
        setFollowing(prev => { const s = new Set(prev); s.delete(String(id)); return s })
      } else {
        await followTrader(String(id), trader.name || trader.agent_name)
        setFollowing(prev => new Set([...prev, String(id)]))
      }
    } catch {} finally { setToggling(null) }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="w-5 h-5 text-slate-600 animate-spin" />
      </div>
    )
  }

  if (traders.length === 0) {
    return (
      <div className="space-y-4">
        <button onClick={onPublish}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
                     bg-mint-500/10 border border-mint-500/25 text-mint-400 text-sm font-semibold
                     hover:bg-mint-500/20 transition-all">
          <Send className="w-4 h-4" />
          Publish Your First Signal
        </button>
        <div className="text-center py-8 text-slate-500 text-sm">
          <AlertTriangle className="w-5 h-5 mx-auto mb-3 opacity-50" />
          Leaderboard unavailable — AI-Trader API not reachable.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Publish shortcut at top of leaderboard */}
      <button onClick={onPublish}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl
                   bg-mint-500/8 border border-mint-500/20 text-mint-400 text-xs font-semibold
                   hover:bg-mint-500/15 transition-all mb-3">
        <Send className="w-3.5 h-3.5" />
        Publish Your Signal to Join the Network
      </button>
      {traders.map((trader, i) => {
        const id     = String(trader.id || trader.agent_id || i)
        const name   = trader.name || trader.agent_name || `Trader #${i + 1}`
        const pnl    = trader.pnl ?? trader.total_pnl ?? null
        const wins   = trader.wins ?? trader.win_rate ?? null
        const sigs   = trader.signal_count ?? trader.signals ?? null
        const isFollowing = following.has(id)
        const busy   = toggling === id

        return (
          <div key={id} className="glass rounded-xl px-4 py-3 border border-white/[0.06] flex items-center gap-3">
            {/* Rank */}
            <div className={`w-6 text-center text-xs font-bold font-mono
              ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-orange-400' : 'text-slate-600'}`}>
              {i + 1}
            </div>

            {/* Avatar placeholder */}
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-mint-400/20 to-indigo-500/20 border border-white/10 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-white/60">{name[0]?.toUpperCase()}</span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white truncate">{name}</span>
                {i < 3 && <Star className="w-3 h-3 text-amber-400 shrink-0" />}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                {pnl  != null && <span className={pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{pnl >= 0 ? '+' : ''}{pnl}%</span>}
                {wins != null && <span>Win: {wins}%</span>}
                {sigs != null && <span>{sigs} signals</span>}
              </div>
            </div>

            {/* Follow toggle */}
            {isAuthenticated && (
              <button
                onClick={() => toggleFollow(trader)}
                disabled={busy}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all
                  ${isFollowing
                    ? 'border-mint-500/30 bg-mint-500/10 text-mint-400 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400'
                    : 'border-white/[0.08] text-slate-400 hover:text-white hover:border-white/15'
                  } disabled:opacity-50`}
              >
                {busy
                  ? <RefreshCw className="w-3 h-3 animate-spin" />
                  : isFollowing
                    ? <><UserMinus className="w-3 h-3" /> Following</>
                    : <><UserPlus  className="w-3 h-3" /> Follow</>
                }
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'signals',       label: 'My Signals',    icon: Send },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'leaderboard',   label: 'Leaderboard',   icon: Users },
]

export default function TradingNetworkView() {
  const { isAuthenticated } = useAuth()
  const { unreadCount, status, registerAgent, loading } = useAITrader()
  const [tab,         setTab]         = useState('signals')
  const [showPublish, setShowPublish] = useState(false)

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-sm">
          <Users className="w-10 h-10 text-slate-600 mx-auto mb-4" />
          <h2 className="text-base font-semibold text-white mb-2">Sign in to access the Trader Network</h2>
          <p className="text-sm text-slate-400">
            Publish signals, follow top traders, and earn reputation points.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">Trader Network</h1>
          <p className="text-xs text-slate-500 mt-1">
            AI-Trader · Publish signals · Follow top traders · Earn reputation
          </p>
        </div>

        {/* Registration / status badge */}
        {!status?.registered ? (
          <button onClick={registerAgent} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                       bg-mint-500/15 border border-mint-500/30 text-mint-400
                       hover:bg-mint-500/25 disabled:opacity-50 transition-all">
            {loading
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Zap className="w-4 h-4" />
            }
            Connect Agent
          </button>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20 text-xs text-emerald-400">
            <Activity className="w-3.5 h-3.5" />
            Agent Active · #{status.agentId}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0">
        {TABS.map(t => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors
                ${active ? 'text-mint-400' : 'text-slate-500 hover:text-slate-300'}`}>
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {t.id === 'notifications' && unreadCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-mint-500/20 text-mint-400">
                  {unreadCount}
                </span>
              )}
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-mint-400 rounded-full" />
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'signals'       && <MySignalsPanel   onPublish={() => setShowPublish(true)} />}
        {tab === 'notifications' && <NotificationsPanel />}
        {tab === 'leaderboard'   && <LeaderboardPanel onPublish={() => setShowPublish(true)} />}
      </div>

      {/* Publish modal */}
      {showPublish && <PublishSignalModal onClose={() => setShowPublish(false)} />}
    </div>
  )
}
