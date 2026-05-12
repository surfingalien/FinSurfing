/**
 * TraderProfileView.jsx
 *
 * Public trader profile: bio, signal history with P&L badges,
 * win-rate stats, follower count. Accessible via the Trading Network leaderboard.
 */

import { useState, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useAITrader } from '../../contexts/AITraderContext'
import {
  User, TrendingUp, TrendingDown, Award, Users, Calendar,
  ArrowLeft, AlertTriangle, UserPlus, UserMinus,
} from 'lucide-react'

// ── P&L badge ─────────────────────────────────────────────────────────────────

function PnlBadge({ pnl, label }) {
  if (pnl == null) return <span className="text-[10px] text-slate-600">pending</span>
  const isPos = pnl >= 0
  return (
    <div className={`flex items-center gap-0.5 text-[10px] font-mono font-semibold
                     px-1.5 py-0.5 rounded-md ${isPos ? 'bg-mint-500/10 text-mint-400' : 'bg-red-500/10 text-red-400'}`}>
      {isPos ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
      {isPos ? '+' : ''}{pnl.toFixed(2)}%
      <span className="text-slate-600 ml-0.5">{label}</span>
    </div>
  )
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({ sig }) {
  const isBull = sig.direction === 'buy'
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-white">{sig.symbol}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${
            isBull ? 'bg-mint-500/10 text-mint-400 border-mint-500/25' : 'bg-red-500/10 text-red-400 border-red-500/25'
          }`}>
            {sig.direction.toUpperCase()}
          </span>
          {sig.conviction && (
            <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-md border border-amber-500/20">
              {sig.conviction}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <PnlBadge pnl={sig.pnl1d}  label="1d" />
          <PnlBadge pnl={sig.pnl7d}  label="7d" />
          <PnlBadge pnl={sig.pnl30d} label="30d" />
        </div>
      </div>
      {sig.timeframe && (
        <div className="text-[10px] text-slate-600 mb-1">Timeframe: {sig.timeframe}</div>
      )}
      {sig.analysis && (
        <p className="text-xs text-slate-400 line-clamp-2">{sig.analysis}</p>
      )}
      <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-600">
        <span className="flex items-center gap-1">
          <Calendar className="w-2.5 h-2.5" />
          {new Date(sig.publishedAt).toLocaleDateString()}
        </span>
        {sig.entryPrice && <span>Entry: ${sig.entryPrice.toFixed(2)}</span>}
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color = 'text-white' }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 mb-2" />}
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TraderProfileView({ username, onBack }) {
  const { authFetch } = useAuth()
  const { followTrader, unfollowTrader } = useAITrader()

  const [profile,   setProfile]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [following, setFollowing] = useState(false)
  const [toggling,  setToggling]  = useState(false)

  useEffect(() => {
    if (!username) return
    setLoading(true); setError(null)
    authFetch(`/api/public/trader/${encodeURIComponent(username)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setProfile(d)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [username])

  const toggleFollow = async () => {
    if (!profile?.agentId || toggling) return
    setToggling(true)
    try {
      if (following) {
        await unfollowTrader(profile.agentId)
        setFollowing(false)
      } else {
        await followTrader(profile.agentId)
        setFollowing(true)
      }
    } catch {}
    setToggling(false)
  }

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="w-6 h-6 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin mx-auto mb-2" />
        <p className="text-slate-500 text-sm">Loading profile…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      </div>
    )
  }

  if (!profile) return null

  const winColor = profile.winRate == null ? 'text-slate-500'
    : profile.winRate >= 60 ? 'text-mint-400'
    : profile.winRate >= 50 ? 'text-amber-400'
    : 'text-red-400'

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Trader Network
      </button>

      {/* Profile header */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-indigo-400 to-mint-400
                            flex items-center justify-center text-xl font-bold text-[#070b14] shrink-0">
              {(profile.displayName || profile.username)?.[0]?.toUpperCase() ?? 'T'}
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{profile.displayName || profile.username}</h2>
              <p className="text-sm text-slate-500">@{profile.username}</p>
              {profile.memberSince && (
                <p className="text-xs text-slate-600 mt-1 flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Member since {new Date(profile.memberSince).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={toggleFollow}
            disabled={toggling}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
              following
                ? 'bg-white/[0.05] border-white/10 text-slate-400 hover:bg-red-500/10 hover:border-red-500/25 hover:text-red-400'
                : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/25'
            } disabled:opacity-50`}
          >
            {following ? <UserMinus className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            {following ? 'Unfollow' : 'Follow'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Signals"   value={profile.totalSignals}  icon={TrendingUp} />
        <StatCard label="Win Rate"        value={profile.winRate != null ? `${profile.winRate}%` : '—'}
                  sub="based on 1-day P&L"     icon={Award}    color={winColor} />
        <StatCard label="Followers"       value={profile.followers}     icon={Users} />
        <StatCard label="AI-Trader ID"    value={`#${profile.agentId}`} icon={User}  color="text-slate-400" />
      </div>

      {/* Signal feed */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3">Recent Signals</h3>
        {profile.recentSignals?.length === 0 ? (
          <div className="p-6 text-center text-slate-600 text-sm bg-white/[0.02] border border-white/[0.05] rounded-xl">
            No signals published yet.
          </div>
        ) : (
          <div className="space-y-3">
            {profile.recentSignals.map((sig, i) => <SignalCard key={i} sig={sig} />)}
          </div>
        )}
      </div>
    </div>
  )
}
