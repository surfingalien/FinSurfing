/**
 * V2Shell.jsx — the v2 "workspace" layout.
 *
 * A frame only: the page inside is the same lazy view v1 renders for the same
 * hash route (passed in as children), so every feature, live data source and
 * AI surface works unchanged. What changes is how they are grouped — eight
 * workspaces in a rail, the pages of the open workspace as tabs along the top.
 */

import { useState, useEffect, useMemo } from 'react'
import {
  Home, Globe, Microscope, Sparkles, Brain, Calculator, Bot, PieChart, ShieldCheck,
  Search, Sun, Moon, Lock, LogIn, LogOut, Bell, KeyRound,
} from 'lucide-react'
import { NAV_COMMANDS } from '../navigation'
import { useAuth } from '../contexts/AuthContext'
import { useLightMode } from '../contexts/LightModeContext'
import { useProMode } from '../contexts/ProModeContext'
import BrandMark from '../components/shared/BrandMark'
import AccountSwitcher from '../components/Portfolio/AccountSwitcher'
import CreatePortfolioModal from '../components/Portfolio/CreatePortfolioModal'
import ApiKeysModal from '../components/Settings/ApiKeysModal'
import VersionSwitch from './VersionSwitch'
import WORKSPACES from './workspaces.json'
import './v2.css'

const WORKSPACE_ICONS = {
  home: Home, markets: Globe, research: Microscope, discover: Sparkles, brain: Brain,
  quant: Calculator, agents: Bot, portfolio: PieChart, admin: ShieldCheck,
}

// Page label / icon / sign-in flag, from the one navigation source.
const PAGE = Object.fromEntries(
  NAV_COMMANDS.filter(c => !c.param).map(c => [c.id, c])
)
PAGE.admin = PAGE.admin || { id: 'admin', label: 'Admin', icon: ShieldCheck }

export function workspaceOf(tab) {
  return WORKSPACES.find(w => w.tabs.includes(tab)) ?? WORKSPACES[0]
}

const LAST_KEY = 'finsurf_v2_last_tabs'
function readLast() {
  try { return JSON.parse(window.sessionStorage.getItem(LAST_KEY)) || {} } catch { return {} }
}

export default function V2Shell({
  activeTab, onNavigate, onOpenPalette, onSignIn, triggeredCount = 0, mainRef, children,
}) {
  const { user, isAuthenticated, logout } = useAuth()
  const { lightMode, toggleLightMode } = useLightMode()
  const { proMode, toggleProMode } = useProMode()

  const workspaces = useMemo(
    () => WORKSPACES.filter(w => !w.admin || user?.role === 'admin'),
    [user?.role]
  )
  const current = workspaceOf(activeTab)

  // Reopen each workspace on the page last used there (this tab session only).
  const [lastTabs, setLastTabs] = useState(readLast)
  useEffect(() => {
    setLastTabs(prev => {
      if (prev[current.id] === activeTab) return prev
      const next = { ...prev, [current.id]: activeTab }
      try { window.sessionStorage.setItem(LAST_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [current.id, activeTab])

  const openWorkspace = (w) => {
    const last = lastTabs[w.id]
    onNavigate(last && w.tabs.includes(last) ? last : w.tabs[0])
  }

  const toggleTheme = () => {
    if (!lightMode && proMode) toggleProMode()
    toggleLightMode()
  }

  const page = PAGE[activeTab]
  const [showKeys, setShowKeys] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="v2-root">
      {/* ── Workspace rail (bottom bar on phones) ── */}
      <nav className="v2-rail" aria-label="Workspaces">
        <div className="v2-rail-brand" title="FinSurfing">
          <BrandMark className="w-7 h-7" />
        </div>
        {workspaces.map(w => {
          const Icon = WORKSPACE_ICONS[w.id] ?? Home
          const on = w.id === current.id
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => openWorkspace(w)}
              className={`v2-rail-item ${on ? 'is-on' : ''}`}
              aria-current={on ? 'page' : undefined}
              title={w.blurb}
            >
              <Icon className="w-[18px] h-[18px]" />
              <span>{w.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="v2-main-col">
        {/* ── Top bar ── */}
        <header className="v2-top">
          <div className="v2-top-title">
            <span className="v2-ws-name">{current.label}</span>
            <span className="v2-ws-blurb">{current.blurb}</span>
          </div>

          <button type="button" className="v2-search" onClick={onOpenPalette} title="Search pages and tickers (⌘K)">
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span className="v2-search-text">Search a ticker or page</span>
            <kbd>⌘K</kbd>
          </button>

          <div className="v2-top-actions">
            {isAuthenticated && (
              <div className="v2-account">
                <AccountSwitcher
                  onManage={() => onNavigate('portfolios')}
                  onCreateNew={() => setShowCreate(true)}
                  compact
                />
              </div>
            )}
            <button type="button" className="v2-icon-btn" onClick={() => setShowKeys(true)} title="API keys">
              <KeyRound className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="v2-icon-btn"
              onClick={() => onNavigate('alerts')}
              title="Alerts"
            >
              <Bell className="w-4 h-4" />
              {triggeredCount > 0 && <span className="v2-badge">{triggeredCount}</span>}
            </button>
            <button
              type="button"
              className="v2-icon-btn"
              onClick={toggleTheme}
              title={lightMode ? 'Dark theme' : 'Light theme'}
            >
              {lightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
            <VersionSwitch />
            {isAuthenticated ? (
              <button type="button" className="v2-icon-btn" onClick={logout} title={`Sign out ${user?.email ?? ''}`}>
                <LogOut className="w-4 h-4" />
              </button>
            ) : (
              <button type="button" className="v2-signin" onClick={onSignIn}>
                <LogIn className="w-3.5 h-3.5" />
                <span>Sign in</span>
              </button>
            )}
          </div>
        </header>

        {/* ── Pages of this workspace ── */}
        <div className="v2-tabs" role="tablist" aria-label={`${current.label} pages`}>
          {current.tabs.map(id => {
            const p = PAGE[id] ?? { label: id }
            const Icon = p.icon
            const on = id === activeTab
            const locked = !!p.auth && !isAuthenticated
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onNavigate(id)}
                className={`v2-tab ${on ? 'is-on' : ''}`}
                title={locked ? 'Sign in to use this page' : p.label}
              >
                {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
                <span>{id === 'portfolios' ? 'Accounts' : p.label}</span>
                {locked && <Lock className="w-3 h-3 opacity-60" />}
              </button>
            )
          })}
        </div>

        <main ref={mainRef} className="v2-content" aria-label={page?.label ?? current.label}>
          <div className="max-w-screen-2xl mx-auto w-full px-4 py-5">
            {children}
          </div>
          <footer className="v2-footer">
            <span>FinSurfing · v2 workspace layout (preview)</span>
            <span>Not financial advice</span>
          </footer>
        </main>
      </div>

      {showCreate && <CreatePortfolioModal onClose={() => setShowCreate(false)} />}
      {showKeys && <ApiKeysModal onClose={() => setShowKeys(false)} />}
    </div>
  )
}
