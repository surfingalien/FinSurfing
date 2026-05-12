/**
 * Sidebar.jsx
 *
 * Left-side navigation panel (replaces the horizontal nav bar).
 * - Expanded (224 px) shows icon + label
 * - Collapsed (56 px) shows icon only with tooltip
 * - Mobile: hidden by default, overlay drawer when open
 * - Logo, Portfolio switcher, nav tabs, user menu, collapse toggle — all here
 */

import { useState, useEffect, useRef } from 'react'
import {
  LayoutDashboard, PieChart, Eye, LineChart, Lightbulb,
  TrendingUp, SlidersHorizontal, GitBranch, Bell, Bot,
  ShieldCheck, ChevronLeft, ChevronRight, LogIn, LogOut,
  User, KeyRound, Activity, X, Menu, FolderOpen, Users, Calendar,
  FlaskConical, BarChart3,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useAITrader } from '../../contexts/AITraderContext'
import AccountSwitcher from '../Portfolio/AccountSwitcher'
import CreatePortfolioModal from '../Portfolio/CreatePortfolioModal'
import ChangePasswordModal from '../Auth/ChangePasswordModal'

// ── Nav item definitions ──────────────────────────────────────────────────────

function buildTabs(user, triggeredCount, tradingUnread) {
  return [
    { id: 'dashboard',       label: 'Dashboard',      icon: LayoutDashboard },
    { id: 'portfolio',       label: 'Portfolio',      icon: PieChart },
    { id: 'watchlist',       label: 'Watchlist',      icon: Eye },
    { id: 'analyze',         label: 'Analyze',        icon: LineChart },
    { id: 'recommendations', label: 'Advisory',       icon: Lightbulb },
    { id: 'montecarlo',      label: 'Retirement',     icon: TrendingUp },
    { id: 'screener',        label: 'Screener',       icon: SlidersHorizontal },
    { id: 'strategies',      label: 'Strategies',     icon: GitBranch },
    { id: 'alerts',          label: 'Alerts',         icon: Bell,  badge: triggeredCount },
    { id: 'research',        label: 'AI Agent',       icon: Bot },
    { id: 'trading',         label: 'Trader Network', icon: Users,         badge: tradingUnread },
    { id: 'earnings',        label: 'Earnings',       icon: Calendar },
    { id: 'backtest',        label: 'Backtester',     icon: FlaskConical },
    { id: 'analytics',       label: 'Risk Analytics', icon: Activity },
    { id: 'rebalancer',      label: 'AI Rebalancer',  icon: BarChart3 },
    ...(user?.role === 'admin'
      ? [{ id: 'admin', label: 'Admin', icon: ShieldCheck, admin: true }]
      : []),
  ]
}

// ── Tooltip wrapper (shows label when collapsed) ──────────────────────────────
function Tooltip({ label, children }) {
  return (
    <div className="relative group/tip">
      {children}
      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 z-[200]
                      px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap
                      bg-[#1a1f2e] border border-white/10 text-white shadow-xl
                      opacity-0 pointer-events-none group-hover/tip:opacity-100
                      transition-opacity duration-150">
        {label}
        <div className="absolute right-full top-1/2 -translate-y-1/2
                        border-4 border-transparent border-r-[#1a1f2e]" />
      </div>
    </div>
  )
}

// ── Single nav item ───────────────────────────────────────────────────────────
function NavItem({ tab, active, collapsed, onClick }) {
  const Icon = tab.icon
  const base =
    'relative flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group'
  const activeStyle = tab.admin
    ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
    : 'bg-mint-500/12 text-mint-400 border border-mint-500/20'
  const idleStyle   = tab.admin
    ? 'text-amber-500/50 hover:text-amber-400 hover:bg-amber-500/8 border border-transparent'
    : 'text-slate-400 hover:text-white hover:bg-white/[0.05] border border-transparent'

  const inner = (
    <button onClick={onClick} className={`${base} ${active ? activeStyle : idleStyle}`}>
      <Icon className={`w-4 h-4 shrink-0 ${active ? '' : 'opacity-70 group-hover:opacity-100'}`} />
      {!collapsed && <span className="truncate">{tab.label}</span>}
      {/* Alert badge */}
      {tab.badge > 0 && (
        <span className={`
          ${collapsed ? 'absolute top-1 right-1' : 'ml-auto'}
          min-w-[18px] h-[18px] px-1 bg-amber-500 text-black text-[9px] font-black
          rounded-full flex items-center justify-center animate-pulse
        `}>
          {tab.badge > 9 ? '9+' : tab.badge}
        </span>
      )}
    </button>
  )

  return collapsed ? <Tooltip label={tab.label}>{inner}</Tooltip> : inner
}

// ── User section (bottom of sidebar) ─────────────────────────────────────────
function UserSection({ collapsed, onNavigate, onSignIn }) {
  const { user, isAuthenticated, logout } = useAuth()
  const [open,         setOpen]         = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (!isAuthenticated) {
    const btn = (
      <button onClick={onSignIn}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium
                   text-slate-400 hover:text-mint-400 hover:bg-mint-500/8 border border-transparent
                   hover:border-mint-500/20 transition-all">
        <LogIn className="w-4 h-4 shrink-0" />
        {!collapsed && 'Sign In'}
      </button>
    )
    return collapsed ? <Tooltip label="Sign In">{btn}</Tooltip> : btn
  }

  const initials = user.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : user.email?.[0]?.toUpperCase() ?? '?'

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm
                   text-slate-300 hover:text-white hover:bg-white/[0.05] transition-all
                   border border-transparent hover:border-white/[0.06]">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-mint-400 to-indigo-500
                        flex items-center justify-center text-[10px] font-bold text-[#0a0e1a] shrink-0">
          {initials}
        </div>
        {!collapsed && (
          <span className="truncate flex-1 text-xs text-left">{user.displayName || user.email}</span>
        )}
      </button>

      {open && (
        <div className={`absolute ${collapsed ? 'left-full ml-2 bottom-0' : 'bottom-full mb-2 left-0 right-0'}
                         z-50 rounded-xl bg-[#0f1117] border border-white/10 shadow-2xl shadow-black/60
                         overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150 min-w-[180px]`}>
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <div className="text-xs font-semibold text-white truncate">{user.displayName || 'Account'}</div>
            <div className="text-[10px] text-slate-500 truncate mt-0.5">{user.email}</div>
          </div>
          <div className="py-1">
            <button onClick={() => { setOpen(false); onNavigate('portfolios') }}
              className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white text-left">
              <FolderOpen size={13} /> Manage Portfolios
            </button>
            <button onClick={() => { setOpen(false); setShowChangePw(true) }}
              className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white text-left">
              <KeyRound size={13} /> Change Password
            </button>
            <div className="my-1 border-t border-white/[0.05]" />
            <button onClick={() => { setOpen(false); logout() }}
              className="w-full flex items-center gap-3 px-4 py-2 text-xs text-red-400 hover:bg-red-500/10 text-left">
              <LogOut size={13} /> Sign Out
            </button>
          </div>
        </div>
      )}

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  )
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────
export default function Sidebar({
  activeTab,
  onTabChange,
  triggeredCount = 0,
  onSignIn,
  mobileOpen,
  onMobileClose,
}) {
  const { user, isAuthenticated } = useAuth()
  const { unreadCount: tradingUnread = 0 } = useAITrader()

  const [collapsed,   setCollapsed]   = useState(() => {
    try { return localStorage.getItem('finsurf_sidebar_collapsed') === '1' } catch { return false }
  })
  const [showCreate, setShowCreate]   = useState(false)

  const tabs = buildTabs(user, triggeredCount, tradingUnread)

  const toggleCollapse = () => {
    setCollapsed(v => {
      const next = !v
      try { localStorage.setItem('finsurf_sidebar_collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }

  const handleTabChange = (id) => {
    onTabChange(id)
    onMobileClose?.()
  }

  const W = collapsed ? 'w-[56px]' : 'w-[220px]'

  // ── Desktop sidebar ──
  const sidebarContent = (
    <div className={`
      flex flex-col h-full
      border-r border-white/[0.06]
      bg-[#070b14]/95 backdrop-blur-md
      transition-all duration-200 ease-in-out
      ${W}
    `}>
      {/* Logo */}
      <div className={`flex items-center shrink-0 h-14 border-b border-white/[0.06]
                       ${collapsed ? 'justify-center px-0' : 'px-4 gap-2'}`}>
        <button onClick={() => handleTabChange('dashboard')}
          className="flex items-center gap-2 shrink-0 min-w-0">
          <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7 shrink-0">
            <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
            <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
          </svg>
          {!collapsed && (
            <span className="font-bold tracking-tight text-base whitespace-nowrap">
              <span className="text-white">FIN</span><span className="text-mint-400">SURF</span>
            </span>
          )}
        </button>
      </div>

      {/* Portfolio switcher */}
      {isAuthenticated && !collapsed && (
        <div className="shrink-0 px-3 py-3 border-b border-white/[0.06]">
          <AccountSwitcher
            onManage={() => handleTabChange('portfolios')}
            onCreateNew={() => setShowCreate(true)}
            compact
          />
        </div>
      )}

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 scrollbar-hide">
        {tabs.map(tab => (
          <NavItem
            key={tab.id}
            tab={tab}
            active={activeTab === tab.id}
            collapsed={collapsed}
            onClick={() => handleTabChange(tab.id)}
          />
        ))}
      </nav>

      {/* Bottom: user + collapse toggle */}
      <div className="shrink-0 border-t border-white/[0.06] px-2 py-3 space-y-1">
        <UserSection collapsed={collapsed} onNavigate={handleTabChange} onSignIn={onSignIn} />

        {/* Collapse toggle — desktop only */}
        <button onClick={toggleCollapse}
          className="hidden lg:flex items-center gap-3 w-full px-3 py-2 rounded-xl text-xs
                     text-slate-600 hover:text-slate-400 hover:bg-white/[0.04] transition-all">
          {collapsed
            ? <ChevronRight className="w-4 h-4 mx-auto" />
            : <><ChevronLeft className="w-4 h-4 shrink-0" /><span>Collapse</span></>
          }
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* ── Desktop sidebar (always visible) ── */}
      <aside className="hidden lg:flex h-screen sticky top-0 shrink-0 flex-col transition-all duration-200">
        {sidebarContent}
      </aside>

      {/* ── Mobile overlay drawer ── */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
               onClick={onMobileClose} />

          {/* Drawer */}
          <aside className="fixed inset-y-0 left-0 z-50 flex flex-col lg:hidden w-[220px]
                            animate-in slide-in-from-left duration-200">
            <div className="flex flex-col h-full border-r border-white/[0.06] bg-[#070b14]">
              {/* Close button */}
              <div className="flex items-center justify-between h-14 px-4 border-b border-white/[0.06] shrink-0">
                <button onClick={() => handleTabChange('dashboard')} className="flex items-center gap-2">
                  <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7 shrink-0">
                    <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
                    <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
                  </svg>
                  <span className="font-bold tracking-tight text-base">
                    <span className="text-white">FIN</span><span className="text-mint-400">SURF</span>
                  </span>
                </button>
                <button onClick={onMobileClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.06]">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Portfolio switcher mobile */}
              {isAuthenticated && (
                <div className="shrink-0 px-3 py-3 border-b border-white/[0.06]">
                  <AccountSwitcher
                    onManage={() => handleTabChange('portfolios')}
                    onCreateNew={() => { setShowCreate(true); onMobileClose?.() }}
                    compact
                  />
                </div>
              )}

              {/* Nav */}
              <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 scrollbar-hide">
                {tabs.map(tab => (
                  <NavItem key={tab.id} tab={tab} active={activeTab === tab.id}
                    collapsed={false} onClick={() => handleTabChange(tab.id)} />
                ))}
              </nav>

              {/* User */}
              <div className="shrink-0 border-t border-white/[0.06] px-2 py-3">
                <UserSection collapsed={false} onNavigate={handleTabChange} onSignIn={onSignIn} />
              </div>
            </div>
          </aside>
        </>
      )}

      {showCreate && <CreatePortfolioModal onClose={() => setShowCreate(false)} />}
    </>
  )
}
