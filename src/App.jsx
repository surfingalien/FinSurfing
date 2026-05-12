import { useState, useMemo, useRef, useCallback } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { PortfolioProvider, usePortfolioContext } from './contexts/PortfolioContext'
import { AITraderProvider } from './contexts/AITraderContext'
import { ToastProvider } from './components/shared/ToastNotifications'
import LandingPage from './components/Landing/LandingPage'
import AuthPage from './components/Auth/AuthPage'
import Header from './components/Layout/Header'
import Sidebar from './components/Layout/Sidebar'
import DashboardView from './components/Dashboard/DashboardView'
import PortfolioView from './components/Portfolio/PortfolioView'
import PortfolioManagerView from './components/Portfolio/PortfolioManagerView'
import PortfolioSetupWizard from './components/Portfolio/PortfolioSetupWizard'
import AdminDashboard from './components/Admin/AdminDashboard'
import WatchlistView from './components/Watchlist/WatchlistView'
import AnalysisView from './components/Analysis/AnalysisView'
import AdvisoryView from './components/Recommendations/AdvisoryView'
import SimulationView from './components/MonteCarlo/SimulationView'
import ScreenerView from './components/Screener/ScreenerView'
import StrategiesView from './components/Strategies/StrategiesView'
import AlertsView from './components/Alerts/AlertsView'
import StockAgentView from './components/Research/StockAgentView'
import TradingNetworkView from './components/Trading/TradingNetworkView'
import EarningsCalendarView from './components/EarningsCalendar/EarningsCalendarView'
import BacktestView from './components/Backtest/BacktestView'
import PortfolioAnalyticsView from './components/Analytics/PortfolioAnalyticsView'
import RebalancerView from './components/Rebalancer/RebalancerView'
import TraderProfileView from './components/Profile/TraderProfileView'
import { usePortfolio } from './hooks/usePortfolio'
import { useWatchlist } from './hooks/useWatchlist'
import { useAlerts } from './hooks/useAlerts'

// ── Inner app (renders once auth state is known) ──────────────────────────────
function AppInner() {
  const { isAuthenticated, loading: authLoading } = useAuth()

  // 'landing' | 'login' | 'register' | 'app'
  const [screen, setScreen] = useState('landing')

  // On session restore, skip straight to app
  if (!authLoading && isAuthenticated && screen === 'landing') {
    // Don't re-render — just fall through to app section below
  }

  // Show spinner while restoring session (only briefly)
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#060810' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-[#00ffcc]/30 border-t-[#00ffcc] rounded-full animate-spin" />
          <span className="text-xs text-slate-600">Restoring session…</span>
        </div>
      </div>
    )
  }

  // Authenticated — go straight to app regardless of screen state
  if (isAuthenticated) {
    return (
      <PortfolioProvider>
        <AITraderProvider>
          <MainApp onSignIn={() => setScreen('landing')} />
        </AITraderProvider>
      </PortfolioProvider>
    )
  }

  // Landing page
  if (screen === 'landing') {
    return (
      <LandingPage
        onSignIn={() => setScreen('login')}
        onRegister={() => setScreen('register')}
        onTryDemo={() => setScreen('app')}
      />
    )
  }

  // Auth forms (login / register / forgot)
  if (screen === 'login' || screen === 'register') {
    return (
      <AuthPage
        initialView={screen}
        onContinueWithoutAccount={() => setScreen('app')}
        onBack={() => setScreen('landing')}
      />
    )
  }

  // Guest / demo app mode
  return (
    <PortfolioProvider>
      <AITraderProvider>
        <MainApp onSignIn={() => setScreen('login')} />
      </AITraderProvider>
    </PortfolioProvider>
  )
}

// ── Main app (authenticated or guest) ─────────────────────────────────────────
function MainApp({ onSignIn }) {
  const { isAuthenticated, user, authFetch } = useAuth()
  const { portfolios, loadingPortfolios, activePortfolioId } = usePortfolioContext()

  const [activeTab,       setActiveTab]       = useState('dashboard')
  const [analyzeSymbol,   setAnalyzeSymbol]   = useState('AAPL')
  const [wizardDone,      setWizardDone]      = useState(false)
  const [mobileNav,       setMobileNav]       = useState(false)
  const [traderUsername,  setTraderUsername]  = useState(null)
  const mainRef = useRef(null)

  // Reset scroll to top whenever the active tab changes
  const changeTab = useCallback((tab) => {
    setActiveTab(tab)
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [])

  // When authenticated: fetch holdings from API, keyed to the active portfolio.
  // When guest: fall back to localStorage namespaced by userId.
  const portfolio = usePortfolio(
    isAuthenticated && activePortfolioId
      ? { userId: user?.id, activePortfolioId, authFetch }
      : { userId: null }
  )
  const watchlist = useWatchlist()

  const quotesMap = useMemo(() => {
    const map = { ...portfolio.quotes }
    watchlist.quotes.forEach(q => { if (q.symbol) map[q.symbol] = q })
    return map
  }, [portfolio.quotes, watchlist.quotes])

  const alertsHook = useAlerts(quotesMap)

  const navigateTo = (tab, symbol) => {
    if (symbol) setAnalyzeSymbol(symbol)
    changeTab(tab)
  }

  const navigateToAnalyze = (symbol) => navigateTo('analyze', symbol)

  const navigateToTraderProfile = (username) => {
    setTraderUsername(username)
    changeTab('trader-profile')
  }

  // Show portfolio setup wizard for new authenticated users with no portfolios
  const showWizard = isAuthenticated && !loadingPortfolios && portfolios.length === 0 && !wizardDone

  if (showWizard) {
    return (
      <PortfolioSetupWizard
        onComplete={() => { setWizardDone(true); setActiveTab('dashboard') }}
      />
    )
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#060810' }}>
      {/* ── Sidebar ── */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={changeTab}
        triggeredCount={alertsHook.triggered.length}
        onSignIn={onSignIn}
        mobileOpen={mobileNav}
        onMobileClose={() => setMobileNav(false)}
      />

      {/* ── Right column: top-bar + scrollable content ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Slim top bar (ticker + hamburger) */}
        <Header onMobileMenuOpen={() => setMobileNav(true)} />

        {/* Scrollable main content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <div className="max-w-screen-2xl mx-auto w-full px-4 py-6">
            {activeTab === 'dashboard' && (
              <DashboardView portfolio={portfolio} onAnalyze={navigateToAnalyze} />
            )}
            {activeTab === 'portfolio' && (
              <PortfolioView portfolio={portfolio} />
            )}
            {activeTab === 'portfolios' && (
              <PortfolioManagerView />
            )}
            {activeTab === 'watchlist' && (
              <WatchlistView watchlist={watchlist} onAnalyze={sym => navigateTo('analyze', sym)} />
            )}
            {activeTab === 'analyze' && (
              <AnalysisView defaultSymbol={analyzeSymbol} />
            )}
            {activeTab === 'recommendations' && (
              <AdvisoryView portfolio={portfolio} />
            )}
            {activeTab === 'montecarlo' && (
              <SimulationView portfolio={portfolio} />
            )}
            {activeTab === 'screener' && (
              <ScreenerView onSelectSymbol={sym => navigateTo('analyze', sym)} />
            )}
            {activeTab === 'strategies' && (
              <StrategiesView onAnalyze={sym => navigateTo('analyze', sym)} />
            )}
            {activeTab === 'alerts' && (
              <AlertsView
                alerts={alertsHook}
                quotesMap={quotesMap}
                portfolioSymbols={portfolio.positions.map(p => p.symbol)}
                watchlistSymbols={watchlist.symbols}
              />
            )}
            {activeTab === 'research' && (
              <StockAgentView portfolio={portfolio} />
            )}
            {activeTab === 'trading' && (
              <TradingNetworkView />
            )}
            {activeTab === 'earnings' && (
              <EarningsCalendarView portfolio={portfolio} onAnalyze={navigateToAnalyze} />
            )}
            {activeTab === 'backtest' && (
              <BacktestView />
            )}
            {activeTab === 'analytics' && (
              <PortfolioAnalyticsView />
            )}
            {activeTab === 'rebalancer' && (
              <RebalancerView />
            )}
            {activeTab === 'trader-profile' && (
              <TraderProfileView
                username={traderUsername}
                onBack={() => changeTab('trading')}
              />
            )}
            {activeTab === 'admin' && (
              <AdminDashboard />
            )}
          </div>

          <footer className="border-t border-white/[0.04] py-4 px-6">
            <div className="max-w-screen-2xl mx-auto flex items-center justify-between text-xs text-slate-600">
              <span>FinSurf v2.0 · Real-time US Equity Platform</span>
              <span>Data via Yahoo Finance · Not financial advice</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  )
}

// ── Root export ───────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </ToastProvider>
  )
}
