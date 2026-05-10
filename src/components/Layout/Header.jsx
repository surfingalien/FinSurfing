import { useState, useEffect, useRef } from 'react'
import { Activity, LogOut, User, ChevronDown, LogIn } from 'lucide-react'
import { fetchQuotes } from '../../services/api'
import { TICKER_SYMBOLS } from '../../data/portfolio'
import { fmt, fmtPct } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import AccountSwitcher from '../Portfolio/AccountSwitcher'
import CreatePortfolioModal from '../Portfolio/CreatePortfolioModal'

// ── User menu (top-right corner when logged in) ───────────────────────────────
function UserMenu({ user, onLogout, onNavigate }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const initials = user.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : user.email?.[0]?.toUpperCase() ?? '?'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06]
                   border border-transparent hover:border-white/[0.08] transition-all"
      >
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#00ffcc] to-[#6366f1]
                        flex items-center justify-center text-[10px] font-bold text-[#0a0e1a] shrink-0">
          {initials}
        </div>
        <span className="text-xs text-slate-300 hidden sm:block max-w-[100px] truncate">
          {user.displayName || user.email}
        </span>
        <ChevronDown size={12} className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 z-50 w-52 rounded-xl
                        bg-[#0f1117] border border-white/10 shadow-2xl shadow-black/60
                        overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          {/* User info header */}
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <div className="text-xs font-semibold text-white truncate">
              {user.displayName || 'Account'}
            </div>
            <div className="text-[10px] text-slate-500 truncate mt-0.5">{user.email}</div>
          </div>

          {/* Actions */}
          <div className="py-1">
            <button
              onClick={() => { setOpen(false); onNavigate('portfolios') }}
              className="w-full flex items-center gap-3 px-4 py-2 text-xs text-slate-300
                         hover:bg-white/5 hover:text-white transition-colors text-left"
            >
              <User size={13} />
              Manage Portfolios
            </button>
            <button
              onClick={() => { setOpen(false); onLogout() }}
              className="w-full flex items-center gap-3 px-4 py-2 text-xs text-red-400
                         hover:bg-red-500/10 transition-colors text-left"
            >
              <LogOut size={13} />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Header ───────────────────────────────────────────────────────────────
export default function Header({ activeTab, onTabChange, triggeredCount = 0, onSignIn }) {
  const { user, isAuthenticated, logout } = useAuth()

  const [tickerData, setTickerData] = useState([])
  const [time,       setTime]       = useState(new Date())
  const [marketOpen, setMarketOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const tabs = [
    { id: 'dashboard',       label: 'Dashboard',    icon: '▦' },
    { id: 'portfolio',       label: 'Portfolio',    icon: '◈' },
    { id: 'watchlist',       label: 'Watchlist',    icon: '◉' },
    { id: 'analyze',         label: 'Analyze',      icon: '◆' },
    { id: 'recommendations', label: 'Advisory',     icon: '◇' },
    { id: 'montecarlo',      label: 'Retirement',   icon: '◎' },
    { id: 'screener',        label: 'Screener',     icon: '◈' },
    { id: 'strategies',      label: 'Strategies',   icon: '▣' },
    { id: 'alerts',          label: 'Alerts',       icon: '◎', badge: triggeredCount },
    { id: 'research',        label: 'AI Advisory',  icon: '◉' },
  ]

  useEffect(() => {
    const t = setInterval(() => {
      const now = new Date()
      setTime(now)
      const day = now.getDay()
      const h = now.getHours(), m = now.getMinutes()
      const mins = h * 60 + m
      setMarketOpen(day >= 1 && day <= 5 && mins >= 570 && mins < 960)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchQuotes(TICKER_SYMBOLS)
        setTickerData(data)
      } catch {}
    }
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [])

  const tickerContent = [...tickerData, ...tickerData].map((q, i) => (
    <span key={i} className="inline-flex items-center gap-2 mr-8 shrink-0">
      <span className="font-semibold text-white font-mono text-xs">{q.symbol}</span>
      <span className="font-mono text-xs text-slate-300">${fmt(q.price)}</span>
      <span className={`text-xs font-mono ${(q.changePct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {fmtPct(q.changePct)}
      </span>
    </span>
  ))

  const handleLogout = async () => {
    await logout()
    // After logout, App will unmount PortfolioProvider and show AuthPage automatically
  }

  return (
    <header className="sticky top-0 z-50">
      {/* Ticker bar */}
      <div className="bg-surface-300/80 backdrop-blur border-b border-white/[0.06] overflow-hidden h-8 flex items-center">
        <div className="shrink-0 px-3 text-[10px] font-semibold text-mint-500 border-r border-white/[0.06] h-full flex items-center bg-surface-400/60">
          LIVE
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="ticker-track text-slate-400">
            {tickerContent.length > 0 ? tickerContent : (
              <span className="text-xs text-slate-500 px-4">Loading market data…</span>
            )}
          </div>
        </div>
        <div className="shrink-0 px-3 border-l border-white/[0.06] h-full flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-[10px] text-slate-400 hidden sm:block">{marketOpen ? 'Market Open' : 'Closed'}</span>
        </div>
      </div>

      {/* Nav bar */}
      <div className="bg-surface-300/90 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-screen-2xl mx-auto px-4 flex items-center gap-4 h-14">
          {/* Logo */}
          <button onClick={() => onTabChange('dashboard')} className="flex items-center gap-2 shrink-0">
            <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7">
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
              <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
            </svg>
            <span className="font-bold tracking-tight text-base">
              <span className="text-white">FIN</span><span className="text-mint-400">SURF</span>
            </span>
          </button>

          {/* Portfolio switcher (only when authenticated) */}
          {isAuthenticated && (
            <AccountSwitcher
              onManage={() => onTabChange('portfolios')}
              onCreateNew={() => setShowCreate(true)}
            />
          )}

          {/* Tabs */}
          <nav className="flex items-center gap-0.5 flex-1 overflow-x-auto scrollbar-hide">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150
                  ${activeTab === tab.id
                    ? 'bg-mint-500/15 text-mint-400 border border-mint-500/25'
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.05]'
                  }`}
              >
                <span className="text-[10px] opacity-60">{tab.icon}</span>
                {tab.label}
                {tab.badge > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-black text-[9px] font-bold rounded-full flex items-center justify-center animate-pulse">
                    {tab.badge > 9 ? '9+' : tab.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Right cluster: clock + user */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden md:flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs font-mono text-slate-400">
                {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>

            {isAuthenticated && user ? (
              <UserMenu user={user} onLogout={handleLogout} onNavigate={onTabChange} />
            ) : (
              <button
                onClick={onSignIn}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400
                           hover:text-[#00ffcc] hover:bg-[#00ffcc]/10 border border-white/[0.06]
                           hover:border-[#00ffcc]/30 transition-all"
              >
                <LogIn size={13} />
                Sign In
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Create portfolio modal — triggered from AccountSwitcher "New Portfolio" */}
      {showCreate && <CreatePortfolioModal onClose={() => setShowCreate(false)} />}
    </header>
  )
}
