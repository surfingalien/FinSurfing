/**
 * AdminDashboard — available only to users with role === 'admin'.
 * Provides user management, portfolio oversight, and access log review.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Shield, Users, Briefcase, Activity, RefreshCw, Loader2,
  ChevronRight, ChevronDown, Lock, Globe, Star, AlertTriangle,
  Search, Eye, Ban, CheckCircle, BarChart2,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const BASE = import.meta.env.VITE_API_URL || ''

// ── helpers ───────────────────────────────────────────────────────────────────
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}
function timeSince(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, title, subtitle, action }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-[#00ffcc]" />
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {subtitle && <p className="text-[10px] text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, accent = '#00ffcc', sub }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
      <div className="text-[10px] text-slate-500 mb-1">{label}</div>
      <div className="text-2xl font-bold" style={{ color: accent }}>{value ?? '—'}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Users table ───────────────────────────────────────────────────────────────
function UsersTable({ authFetch }) {
  const [users,    setUsers]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [search,   setSearch]   = useState('')
  const [locking,  setLocking]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await authFetch(`${BASE}/api/admin/users?limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setUsers(d.users || d || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const lockUser = async (userId, lock) => {
    setLocking(userId)
    try {
      await authFetch(`${BASE}/api/admin/users/${userId}/lock`, {
        method: 'POST', body: { locked: lock },
      })
      setUsers(u => u.map(x => x.id === userId ? { ...x, locked: lock } : x))
    } catch {}
    finally { setLocking(null) }
  }

  const filtered = users.filter(u =>
    !search || u.email?.includes(search) || u.username?.includes(search)
  )

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <SectionHeader
        icon={Users}
        title="Users"
        subtitle={`${users.length} registered`}
        action={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="pl-7 pr-3 py-1.5 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08]
                           text-slate-300 placeholder-slate-600 focus:outline-none focus:border-[#00ffcc]/40
                           w-36 transition-all"
              />
            </div>
            <button onClick={load} className="p-1.5 rounded-lg text-slate-500 hover:text-[#00ffcc]
                                               hover:bg-[#00ffcc]/10 transition-colors">
              <RefreshCw size={12} />
            </button>
          </div>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-600" /></div>
      ) : error ? (
        <div className="px-4 py-6 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle size={13} /> {error}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.05]">
                {['User', 'Username', 'Role', 'Verified', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[10px] text-slate-600 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <tr key={u.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#00ffcc]/30 to-[#6366f1]/30
                                      flex items-center justify-center text-[10px] font-bold text-slate-300 shrink-0">
                        {(u.email?.[0] || '?').toUpperCase()}
                      </div>
                      <div>
                        <div className="text-slate-200 truncate max-w-[160px]">{u.email}</div>
                        {u.locked && <div className="text-[9px] text-red-400 font-medium">LOCKED</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono">
                    {u.username ? `@${u.username}` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium
                      ${u.role === 'admin'
                        ? 'bg-amber-500/15 text-amber-400'
                        : 'bg-white/5 text-slate-500'}`}>
                      {u.role || 'user'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {u.email_verified
                      ? <CheckCircle size={12} className="text-emerald-400" />
                      : <span className="text-[10px] text-slate-600">Pending</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{timeSince(u.created_at)}</td>
                  <td className="px-4 py-2.5">
                    {u.role !== 'admin' && (
                      <button
                        onClick={() => lockUser(u.id, !u.locked)}
                        disabled={locking === u.id}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors
                          ${u.locked
                            ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                            : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}
                      >
                        {locking === u.id
                          ? <Loader2 size={10} className="animate-spin" />
                          : u.locked ? <CheckCircle size={10} /> : <Ban size={10} />}
                        {u.locked ? 'Unlock' : 'Lock'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600">No users found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Portfolios table ──────────────────────────────────────────────────────────
function PortfoliosTable({ authFetch }) {
  const [portfolios, setPortfolios] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [featuring,  setFeaturing]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await authFetch(`${BASE}/api/admin/portfolios?limit=50`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setPortfolios(d.portfolios || d || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const toggleFeatured = async (id, current) => {
    setFeaturing(id)
    try {
      await authFetch(`${BASE}/api/admin/portfolios/${id}/feature`, {
        method: 'PATCH', body: { featured: !current },
      })
      setPortfolios(p => p.map(x => x.id === id ? { ...x, is_featured: !current } : x))
    } catch {}
    finally { setFeaturing(null) }
  }

  const visIcon = { public: <Globe size={10} className="text-[#00ffcc]" />, private: <Lock size={10} className="text-slate-600" />, followers_only: <Users size={10} className="text-[#6366f1]" /> }

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <SectionHeader
        icon={Briefcase}
        title="Portfolios"
        subtitle={`${portfolios.length} total`}
        action={
          <button onClick={load} className="p-1.5 rounded-lg text-slate-500 hover:text-[#00ffcc]
                                             hover:bg-[#00ffcc]/10 transition-colors">
            <RefreshCw size={12} />
          </button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-600" /></div>
      ) : error ? (
        <div className="px-4 py-6 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle size={13} /> {error}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.05]">
                {['Portfolio', 'Owner', 'Visibility', 'Holdings', 'Featured', 'System'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[10px] text-slate-600 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {portfolios.map(p => (
                <tr key={p.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-200 truncate max-w-[160px]">{p.name}</div>
                    <div className="text-[10px] text-slate-600">{p.type}</div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono text-[10px]">
                    {p.owner_email || p.owner_username || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1 capitalize">
                      {visIcon[p.visibility] || visIcon.private}
                      <span className="text-slate-400">{p.visibility}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{p.holding_count ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => toggleFeatured(p.id, p.is_featured)}
                      disabled={featuring === p.id || p.is_system}
                      className={`p-1 rounded transition-colors ${
                        p.is_featured ? 'text-amber-400 hover:text-amber-300' : 'text-slate-600 hover:text-amber-400'
                      }`}
                      title={p.is_featured ? 'Un-feature' : 'Feature this portfolio'}
                    >
                      {featuring === p.id
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Star size={12} fill={p.is_featured ? 'currentColor' : 'none'} />}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    {p.is_system && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                        SYSTEM
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {portfolios.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600">No portfolios found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Access logs ───────────────────────────────────────────────────────────────
function AccessLogsTable({ authFetch }) {
  const [logs,    setLogs]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await authFetch(`${BASE}/api/admin/access-logs?limit=50`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setLogs(d.logs || d || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <SectionHeader
        icon={Activity}
        title="Recent Access Logs"
        subtitle="Last 50 portfolio views"
        action={
          <button onClick={load} className="p-1.5 rounded-lg text-slate-500 hover:text-[#00ffcc]
                                             hover:bg-[#00ffcc]/10 transition-colors">
            <RefreshCw size={12} />
          </button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-600" /></div>
      ) : error ? (
        <div className="px-4 py-6 text-xs text-red-400 flex items-center gap-2">
          <AlertTriangle size={13} /> {error}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.05]">
                {['Portfolio', 'Accessor', 'Action', 'IP', 'When'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[10px] text-slate-600 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={l.id || i} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 text-slate-300 truncate max-w-[160px]">
                    {l.portfolio_name || l.portfolio_id}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono text-[10px]">
                    {l.accessor_email || l.accessor_id || 'anonymous'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium
                      ${l.action === 'view' ? 'bg-blue-500/10 text-blue-400'
                      : l.action === 'admin_view' ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-white/5 text-slate-500'}`}>
                      {l.action || 'view'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 font-mono text-[10px]">
                    {l.ip_address || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{timeSince(l.created_at || l.accessed_at)}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-600">No access logs yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Overview stats ────────────────────────────────────────────────────────────
function OverviewStats({ authFetch }) {
  const [stats,   setStats]   = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch users + portfolios and compute counts client-side
      const [uRes, pRes] = await Promise.all([
        authFetch(`${BASE}/api/admin/users?limit=1`),
        authFetch(`${BASE}/api/admin/portfolios?limit=1`),
      ])
      const u = uRes.ok ? await uRes.json() : {}
      const p = pRes.ok ? await pRes.json() : {}
      setStats({
        users:      u.total ?? (u.users?.length ?? '—'),
        portfolios: p.total ?? (p.portfolios?.length ?? '—'),
        public:     p.publicCount ?? '—',
      })
    } catch {}
    finally { setLoading(false) }
  }, [authFetch])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {[1,2,3].map(i => (
        <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 animate-pulse">
          <div className="h-2 w-16 bg-white/10 rounded mb-2" />
          <div className="h-6 w-10 bg-white/5 rounded" />
        </div>
      ))}
    </div>
  )

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <StatCard label="Total Users"      value={stats?.users}      />
      <StatCard label="Total Portfolios" value={stats?.portfolios}  accent="#8b5cf6" />
      <StatCard label="Public Portfolios" value={stats?.public}    accent="#f59e0b" />
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
const SECTIONS = ['overview', 'users', 'portfolios', 'logs']
const SECTION_LABELS = { overview: 'Overview', users: 'Users', portfolios: 'Portfolios', logs: 'Access Logs' }

export default function AdminDashboard() {
  const { authFetch, user } = useAuth()
  const [section, setSection] = useState('overview')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
          <Shield size={18} className="text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Admin Console</h1>
          <p className="text-xs text-slate-500">
            Logged in as <span className="text-amber-400 font-medium">{user?.email}</span>
          </p>
        </div>
        <span className="ml-auto px-2 py-1 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/25">
          ADMIN
        </span>
      </div>

      {/* Section tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.05] w-fit">
        {SECTIONS.map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              section === s
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
            }`}
          >
            {SECTION_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Sections */}
      {section === 'overview'    && <OverviewStats   authFetch={authFetch} />}
      {section === 'users'       && <UsersTable      authFetch={authFetch} />}
      {section === 'portfolios'  && <PortfoliosTable authFetch={authFetch} />}
      {section === 'logs'        && <AccessLogsTable authFetch={authFetch} />}
    </div>
  )
}
