/**
 * V3Shell.jsx — the v3 redesign, built from the Dev preview reviewed on
 * 2026-11-03: a grouped side rail, a search-first top bar with Ask Copilot,
 * the live ticker, and each workspace opening on an eyebrow + headline with
 * its pages as a segmented control. Dark by default (as reviewed), with its
 * own light theme.
 *
 * Every page inside is the same live view v1 renders for the same hash route
 * (passed in as children); v3.css re-skins the shared classes those pages use
 * so they take on the Dev preview's palette and type without being forked.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Home, Globe, Microscope, Filter, Brain, Calculator, Bot, Briefcase, ShieldCheck,
  Search, Sun, Moon, Lock, LogIn, LogOut, Bell, KeyRound, FolderOpen, Settings,
  Sparkles, Menu, X,
} from 'lucide-react'
import { NAV_COMMANDS } from '../navigation'
import { useAuth } from '../contexts/AuthContext'
import { useLightMode } from '../contexts/LightModeContext'
import { useProMode } from '../contexts/ProModeContext'
import { useApiKeys } from '../contexts/ApiKeysContext'
import AccountSwitcher from '../components/Portfolio/AccountSwitcher'
import CreatePortfolioModal from '../components/Portfolio/CreatePortfolioModal'
import ApiKeysModal from '../components/Settings/ApiKeysModal'
import ChangePasswordModal from '../components/Auth/ChangePasswordModal'
import VersionSwitch from '../v2/VersionSwitch'
import Ticker from '../v2/V2Ticker'
import WORKSPACES from './workspaces.json'
import { HeroContext } from './hero'
import './v3.css'

const ICONS = {
  home: Home, markets: Globe, research: Microscope, discover: Filter, brain: Brain,
  quant: Calculator, agents: Bot, portfolio: Briefcase, admin: ShieldCheck,
}

const PAGE = Object.fromEntries(NAV_COMMANDS.filter(c => !c.param).map(c => [c.id, c]))
PAGE.admin = PAGE.admin || { id: 'admin', label: 'Admin', icon: ShieldCheck }
const PAGE_LABEL = { portfolios: 'Manage Portfolios', 'brain-activity': 'Overview', macro: 'Overview', screener: 'Overview' }

export function workspaceOf(tab) {
  return WORKSPACES.find(w => w.tabs.includes(tab)) ?? WORKSPACES[0]
}

const THEME_KEY = 'finsurf_v3_theme'
const LAST_KEY = 'finsurf_v3_last_tabs'
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap'

function readJson(key, store) {
  try { return JSON.parse(store.getItem(key)) } catch { return null }
}

// v3 owns the page theme while it is showing: dark (as reviewed) or light,
// never Pro. The app-wide light/Pro preferences are put back when you leave.
function useV3Theme() {
  const { lightMode } = useLightMode()
  const { proMode } = useProMode()
  const [theme, setTheme] = useState(() => {
    // A saved choice wins; otherwise follow the system, as the Dev preview does.
    try {
      const saved = window.localStorage.getItem(THEME_KEY)
      if (saved === 'light' || saved === 'dark') return saved
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    } catch { return 'dark' }
  })
  const restore = useRef({ lightMode, proMode })
  restore.current = { lightMode, proMode }

  useEffect(() => {
    const el = document.documentElement
    el.classList.add('v3')
    el.classList.remove('pro-mode')
    el.classList.toggle('light-mode', theme === 'light')
    try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* ignore */ }
  }, [theme])

  useEffect(() => () => {
    const el = document.documentElement
    el.classList.remove('v3')
    el.classList.toggle('light-mode', restore.current.lightMode)
    el.classList.toggle('pro-mode', restore.current.proMode)
  }, [])

  useEffect(() => {
    if (document.querySelector('link[data-v3-fonts]')) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = FONTS_HREF
    link.dataset.v3Fonts = '1'
    document.head.appendChild(link)
  }, [])

  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

function AccountCard({ user, isAuthenticated, onSignIn, onNavigate, onKeys, onPassword, onLogout, onCreate }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (!isAuthenticated) {
    return (
      <div className="v3-foot">
        <b>Guest demo</b>
        <span>Market data, charts and your watchlist are open. Sign in for the AI Brain, scans and agents.</span>
        <button type="button" className="v3-btn primary" onClick={onSignIn}>
          <LogIn className="w-4 h-4" /> Sign in
        </button>
      </div>
    )
  }

  const initials = user?.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? '?'
  const item = (Icon, label, fn, danger) => (
    <button type="button" className={`v3-menu-item ${danger ? 'is-danger' : ''}`}
      onClick={() => { setOpen(false); fn() }}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  )

  return (
    <div className="v3-foot" ref={ref}>
      <div className="v3-foot-acct">
        <AccountSwitcher onManage={() => onNavigate('portfolios')} onCreateNew={onCreate} compact />
      </div>
      <button type="button" className="v3-user" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="v3-avatar">{initials}</span>
        <span className="v3-user-text">
          <b>{user?.displayName || 'Account'}</b>
          <span>{user?.email}</span>
        </span>
      </button>
      {open && (
        <div className="v3-menu" role="menu">
          {item(FolderOpen, 'Manage Portfolios', () => onNavigate('portfolios'))}
          {item(Settings, 'API Keys', onKeys)}
          {item(KeyRound, 'Change Password', onPassword)}
          {item(LogOut, 'Sign Out', onLogout, true)}
        </div>
      )}
    </div>
  )
}

export default function V3Shell({
  activeTab, onNavigate, onOpenPalette, onSignIn, triggeredCount = 0, mainRef, children,
}) {
  const { user, isAuthenticated, logout } = useAuth()
  const { hasAnyKey } = useApiKeys()
  const [theme, toggleTheme] = useV3Theme()
  const [drawer, setDrawer] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [hero, setHero] = useState(null)
  const heroCtx = useMemo(() => ({ setHero }), [])

  const workspaces = useMemo(
    () => WORKSPACES.filter(w => !w.admin || user?.role === 'admin'),
    [user?.role]
  )
  const current = workspaceOf(activeTab)
  const groups = useMemo(() => {
    const out = []
    for (const w of workspaces) {
      let g = out.find(x => x.label === w.group)
      if (!g) out.push(g = { label: w.group, items: [] })
      g.items.push(w)
    }
    return out
  }, [workspaces])

  // Each workspace reopens on the page last used there (this tab session).
  const [lastTabs, setLastTabs] = useState(() => readJson(LAST_KEY, window.sessionStorage) || {})
  useEffect(() => {
    setLastTabs(prev => {
      if (prev[current.id] === activeTab) return prev
      const next = { ...prev, [current.id]: activeTab }
      try { window.sessionStorage.setItem(LAST_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [current.id, activeTab])

  const openWorkspace = (w) => {
    setDrawer(false)
    const last = lastTabs[w.id]
    onNavigate(last && w.tabs.includes(last) ? last : w.tabs[0])
  }

  // "/" focuses search, as in the Dev preview.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      const t = e.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      onOpenPalette?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpenPalette])

  const askCopilot = () => window.dispatchEvent(new Event('finsurf:open-copilot'))

  return (
    <div className={`v3-root ${drawer ? 'drawer-open' : ''}`} data-theme={theme}>
      {/* ── Rail ── */}
      <aside className="v3-rail" aria-label="Workspaces">
        <div className="v3-brand">
          <span className="v3-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round"><path d="M3 15c3 0 3-4 6-4s3 4 6 4 3-6 6-6" /><path d="M3 19h18" opacity=".55" /></svg>
          </span>
          <span className="v3-brand-name">Fin<span>Surfing</span></span>
          <button type="button" className="v3-drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu">
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="v3-nav">
          {groups.map(g => (
            <div key={g.label}>
              <div className="v3-navg">{g.label}</div>
              {g.items.map(w => {
                const Icon = ICONS[w.id] ?? Home
                const on = w.id === current.id
                return (
                  <button key={w.id} type="button" onClick={() => openWorkspace(w)}
                    className={`v3-nav-item ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined}>
                    <Icon className="w-[18px] h-[18px]" />
                    <span>{w.label}</span>
                    {w.id === 'home' && triggeredCount > 0 && <span className="v3-count is-alert">{triggeredCount}</span>}
                    {w.id !== 'home' && <span className="v3-count">{w.tabs.length}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <AccountCard
          user={user}
          isAuthenticated={isAuthenticated}
          onSignIn={onSignIn}
          onNavigate={(t) => { setDrawer(false); onNavigate(t) }}
          onKeys={() => setShowKeys(true)}
          onPassword={() => setShowPw(true)}
          onLogout={logout}
          onCreate={() => setShowCreate(true)}
        />
      </aside>
      <div className="v3-scrim" onClick={() => setDrawer(false)} />

      {/* ── Main column ── */}
      <main ref={mainRef} className="v3-main">
        <div className="v3-top">
          <div className="v3-top-row">
            <button type="button" className="v3-icon v3-burger" onClick={() => setDrawer(true)} aria-label="Open menu">
              <Menu className="w-5 h-5" />
            </button>
            <button type="button" className="v3-search" onClick={onOpenPalette}>
              <Search className="w-4 h-4 shrink-0" />
              <span>Search a ticker, company or page</span>
              <kbd>/</kbd>
            </button>
            <div className="v3-top-actions">
              <VersionSwitch />
              <button type="button" className="v3-icon" onClick={() => onNavigate('alerts')} title="Alerts">
                <Bell className="w-[18px] h-[18px]" />
                {triggeredCount > 0 && <span className="v3-badge">{triggeredCount}</span>}
              </button>
              <button type="button" className={`v3-icon ${hasAnyKey ? '' : 'is-warn'}`} onClick={() => setShowKeys(true)}
                title={hasAnyKey ? 'API keys' : 'API keys — required: add a data provider key'}>
                <Settings className="w-[18px] h-[18px]" />
                {!hasAnyKey && <span className="v3-dot" />}
              </button>
              <button type="button" className="v3-icon" onClick={toggleTheme}
                title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
                {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
              </button>
              {isAuthenticated ? (
                <button type="button" className="v3-btn primary v3-ask" onClick={askCopilot}>
                  <Sparkles className="w-4 h-4" /> <span>Ask Copilot</span>
                </button>
              ) : (
                <button type="button" className="v3-btn primary v3-ask" onClick={onSignIn}>
                  <LogIn className="w-4 h-4" /> <span>Sign in</span>
                </button>
              )}
            </div>
          </div>
          <Ticker prefix="v3" />
        </div>

        <div className="v3-page">
          <div className="v3-vhead">
            <div>
              <div className="v3-eyebrow">{hero?.eyebrow ?? current.eyebrow}</div>
              <h1>{hero?.headline ?? current.headline}</h1>
            </div>
            {hero?.actions?.length > 0 && (
              <div className="v3-hero-actions">
                {hero.actions.map(a => (
                  <button key={a.label} type="button" className={`v3-btn ${a.primary ? 'primary' : ''}`} onClick={a.onClick}>{a.label}</button>
                ))}
              </div>
            )}
          </div>
          {current.tabs.length > 1 && (
            <div className="v3-tabs" role="tablist" aria-label={`${current.label} pages`}>
              {current.tabs.map(id => {
                const p = PAGE[id] ?? { label: id }
                const locked = !!p.auth && !isAuthenticated
                const on = id === activeTab
                return (
                  <button key={id} type="button" role="tab" aria-selected={on}
                    className={on ? 'on' : ''} onClick={() => onNavigate(id)}
                    title={locked ? 'Sign in to use this page' : undefined}>
                    {PAGE_LABEL[id] ?? p.label}
                    {p.tag && <em className="v3-tag">{p.tag}</em>}
                    {id === 'alerts' && triggeredCount > 0 && <em className="v3-tag is-alert">{triggeredCount}</em>}
                    {locked && <Lock className="w-3 h-3 opacity-60" />}
                  </button>
                )
              })}
            </div>
          )}

          <div className="v3-body">
            <HeroContext.Provider value={heroCtx}>{children}</HeroContext.Provider>
          </div>

          <footer className="v3-footer">
            <span>FinSurfing · v3 redesign (preview)</span>
            <span>Not financial advice</span>
          </footer>
        </div>
      </main>

      {showCreate && <CreatePortfolioModal onClose={() => setShowCreate(false)} />}
      {showKeys && <ApiKeysModal onClose={() => setShowKeys(false)} />}
      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
    </div>
  )
}
