import { useState, useMemo } from 'react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { PortfolioProvider, usePortfolioContext } from './contexts/PortfolioContext'
import LandingPage from './components/Landing/LandingPage'
import AuthPage from './components/Auth/AuthPage'
import Header from './components/Layout/Header'
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
import AIAdvisoryView from './components/Research/AIAdvisoryView'
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
        <MainApp onSignIn={() => setScreen('landing')} />
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
      <MainApp onSignIn={() => setScreen('login')} />
    </PortfolioProvider>
  )
}

// ── Main app (authenticated or guest) ─────────────────────────────────────────
function MainApp({ onSignIn }) {
  const { isAuthenticated } = useAuth()
  const { portfolios, loadingPortfolios } = usePortfolioContext()

  const [activeTab,     setActiveTab]     = useState('dashboard')
  const [analyzeSymbol, setAnalyzeSymbol] = useState('AAPL')
  const [wizardDone,    setWizardDone]    = useState(false)

  const portfolio = usePortfolio()
  const watchlist = useWatchlist()

  const quotesMap = useMemo(() => {
    const map = { ...portfolio.quotes }
    watchlist.quotes.forEach(q => { if (q.symbol) map[q.symbol] = q })
    return map
  }, [portfolio.quotes, watchlist.quotes])

  const alertsHook = useAlerts(quotesMap)

  const navigateTo = (tab, symbol) => {
    if (symbol) setAnalyzeSymbol(symbol)
    setActiveTab(tab)
  }

  const navigateToAnalyze = (symbol) => navigateTo('analyze', symbol)

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
    <div className="min-h-screen flex flex-col">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        triggeredCount={alertsHook.triggered.length}
        onSignIn={onSignIn}
      />

      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-4 py-6">
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
          <AIAdvisoryView portfolio={portfolio} />
        )}
        {activeTab === 'admin' && (
          <AdminDashboard />
        )}
      </main>

      <footer className="border-t border-white/[0.04] py-4 px-6">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between text-xs text-slate-600">
          <span>FinSurf v2.0 · Real-time US Equity Platform</span>
          <span>Data via Yahoo Finance · Not financial advice</span>
        </div>
      </footer>
    </div>
  )
}

// ── Root export ───────────────────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  )
}
