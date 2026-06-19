import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { PortfolioProvider, usePortfolioContext } from './contexts/PortfolioContext'
import { ApiKeysProvider } from './contexts/ApiKeysContext'
import { ProModeProvider } from './contexts/ProModeContext'
import { ToastProvider } from './components/shared/ToastNotifications'
import { TooltipProvider } from './components/shared/Tooltip'
import LandingPage from './components/Landing/LandingPage'
import Header from './components/Layout/Header'
import Sidebar from './components/Layout/Sidebar'
import CommandPalette from './components/shared/CommandPalette'
import { useHashRoute } from './hooks/useHashRoute'
import { usePortfolio } from './hooks/usePortfolio'
import { useWatchlist } from './hooks/useWatchlist'
import { useAlerts } from './hooks/useAlerts'
import { useAlertStream, formatAnalysisToast } from './hooks/useAlertStream'
import { useToast } from './components/shared/ToastNotifications'

// ── Lazy views — each becomes its own chunk, loaded on first visit ────────────
const AuthPage               = lazy(() => import('./components/Auth/AuthPage'))
const PortfolioSetupWizard   = lazy(() => import('./components/Portfolio/PortfolioSetupWizard'))
const FinSurfCopilot         = lazy(() => import('./components/Copilot/FinSurfCopilot'))

const DashboardView          = lazy(() => import('./components/Dashboard/DashboardView'))
const PortfolioView          = lazy(() => import('./components/Portfolio/PortfolioView'))
const PortfolioManagerView   = lazy(() => import('./components/Portfolio/PortfolioManagerView'))
const AdminDashboard         = lazy(() => import('./components/Admin/AdminDashboard'))
const WatchlistView          = lazy(() => import('./components/Watchlist/WatchlistView'))
const AnalysisView           = lazy(() => import('./components/Analysis/AnalysisView'))
const AdvisoryView           = lazy(() => import('./components/Recommendations/AdvisoryView'))
const SimulationView         = lazy(() => import('./components/MonteCarlo/SimulationView'))
const StrategiesView         = lazy(() => import('./components/Strategies/StrategiesView'))
const AlertsView             = lazy(() => import('./components/Alerts/AlertsView'))
const StockAgentView         = lazy(() => import('./components/Research/StockAgentView'))
const ResearchNotesView      = lazy(() => import('./components/Research/ResearchNotesView'))
const QuantMindView          = lazy(() => import('./components/Research/QuantMindView'))
const PolymarketView         = lazy(() => import('./components/Polymarket/PolymarketView'))
const MacroView              = lazy(() => import('./components/Macro/MacroView'))
const RiskRulesView          = lazy(() => import('./components/Risk/RiskRulesView'))
const TradeSetupView         = lazy(() => import('./components/Orders/TradeSetupView'))
const BacktestView           = lazy(() => import('./components/Backtest/BacktestView'))
const BuySignalsView         = lazy(() => import('./components/Recommendations/BuySignalsView'))
const AIBrainView            = lazy(() => import('./components/AIBrain/AIBrainView'))
const BrainActivityView      = lazy(() => import('./components/BrainActivity/BrainActivityView'))
const MarketFocusView        = lazy(() => import('./components/MarketFocus/MarketFocusView'))
const AIWatchlistView        = lazy(() => import('./components/AIWatchlist/AIWatchlistView'))
const AgentHubView           = lazy(() => import('./components/AgentHub/AgentHubView'))
const TradeTimelineView      = lazy(() => import('./components/Timeline/TradeTimelineView'))
const PortfolioAnalyticsView = lazy(() => import('./components/Analytics/PortfolioAnalyticsView'))
const RebalancerView         = lazy(() => import('./components/Rebalancer/RebalancerView'))
const TradingViewView        = lazy(() => import('./components/TradingView/TradingViewView'))
const GoalsView              = lazy(() => import('./components/Goals/GoalsView'))
const AgenticOSView          = lazy(() => import('./components/AgenticOS/AgenticOSView'))
const DCFView                = lazy(() => import('./components/DCF/DCFView'))
const PatternFinderView      = lazy(() => import('./components/PatternFinder/PatternFinderView'))
const DividendView           = lazy(() => import('./components/Dividend/DividendView'))

// ── Shared loading spinner ────────────────────────────────────────────────────
function LoadingScreen({ label = 'Loading…', fullScreen = false }) {
  return (
    <div className={`flex items-center justify-center ${fullScreen ? 'min-h-screen' : 'py-24'}`}
         style={fullScreen ? { background: '#060810' } : undefined}>
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-[#00ffcc]/30 border-t-[#00ffcc] rounded-full animate-spin" />
        <span className="text-xs text-slate-600">{label}</span>
      </div>
    </div>
  )
}

// ── Inner app (renders once auth state is known) ──────────────────────────────
function AppInner() {
  const { isAuthenticated, loading: authLoading } = useAuth()

  // 'landing' | 'login' | 'register' | 'app'
  const [screen, setScreen] = useState('landing')

  // Show spinner while restoring session (only briefly)
  if (authLoading) {
    return <LoadingScreen label="Restoring session…" fullScreen />
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
      <Suspense fallback={<LoadingScreen fullScreen />}>
        <AuthPage
          initialView={screen}
          onContinueWithoutAccount={() => setScreen('app')}
          onBack={() => setScreen('landing')}
        />
      </Suspense>
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
  const { isAuthenticated, user, authFetch } = useAuth()
  const { portfolios, loadingPortfolios, activePortfolioId } = usePortfolioContext()

  // Hash routing: #/<tab>[/<param>] — deep links + browser back/forward
  const [route, navigate] = useHashRoute()
  const activeTab = route.tab

  const [analyzeSymbol, setAnalyzeSymbol] = useState('AAPL')
  const [wizardDone,    setWizardDone]    = useState(false)
  const [mobileNav,     setMobileNav]     = useState(false)
  const [paletteOpen,   setPaletteOpen]   = useState(false)
  const mainRef = useRef(null)

  // Deep link like #/analyze/NVDA sets the symbol; it persists across tabs
  useEffect(() => {
    if (route.tab === 'analyze' && route.param) {
      setAnalyzeSymbol(route.param.toUpperCase())
    }
  }, [route])

  // Reset scroll to top whenever the active tab changes
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [activeTab])

  // ⌘K / Ctrl+K opens the command palette
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
  const { fire: fireToast } = useToast() || {}
  useAlertStream((event) => {
    const toast = formatAnalysisToast(event)
    fireToast?.(toast.type, toast.content)
  })

  const navigateTo = useCallback((tab, symbol) => {
    navigate(tab, symbol)
  }, [navigate])

  const navigateToAnalyze = useCallback((symbol) => navigate('analyze', symbol), [navigate])

  // ── View registry — one lazy chunk per tab ──
  const views = {
    'dashboard':       () => <DashboardView portfolio={portfolio} onAnalyze={navigateToAnalyze} />,
    'portfolio':       () => <PortfolioView portfolio={portfolio} portfolioId={activePortfolioId} authFetch={isAuthenticated ? authFetch : null} />,
    'portfolios':      () => <PortfolioManagerView />,
    'watchlist':       () => <WatchlistView watchlist={watchlist} onAnalyze={navigateToAnalyze} />,
    'analyze':         () => <AnalysisView defaultSymbol={analyzeSymbol} />,
    'recommendations': () => <AdvisoryView portfolio={portfolio} />,
    'montecarlo':      () => <SimulationView portfolio={portfolio} />,
    'strategies':      () => <StrategiesView onAnalyze={navigateToAnalyze} />,
    'alerts':          () => (
      <AlertsView
        alerts={alertsHook}
        quotesMap={quotesMap}
        portfolioSymbols={portfolio.positions.map(p => p.symbol)}
        watchlistSymbols={watchlist.symbols}
      />
    ),
    'research':       () => <StockAgentView portfolio={portfolio} />,
    'second-brain':   () => <ResearchNotesView portfolio={portfolio} />,
    'quantmind':      () => <QuantMindView />,
    'polymarket':     () => <PolymarketView portfolio={portfolio} />,
    'macro':          () => <MacroView />,
    'risk-rules':     () => <RiskRulesView portfolio={portfolio} />,
    'trade-setups':   () => <TradeSetupView portfolio={portfolio} />,
    'backtest':       () => <BacktestView />,
    'buy-signals':    () => <BuySignalsView portfolio={portfolio} onAnalyze={navigateToAnalyze} />,
    'ai-brain':       () => <AIBrainView portfolio={portfolio} onAnalyze={navigateToAnalyze} />,
    'brain-activity': () => <BrainActivityView onAnalyze={navigateToAnalyze} />,
    'market-focus':   () => <MarketFocusView portfolio={portfolio} watchlist={watchlist.symbols} />,
    'ai-watchlist':   () => <AIWatchlistView onAnalyze={navigateToAnalyze} />,
    'tradingview':    () => <TradingViewView />,
    'analytics':      () => <PortfolioAnalyticsView portfolio={portfolio} />,
    'rebalancer':     () => <RebalancerView />,
    'goals':          () => <GoalsView portfolio={portfolio} />,
    'agent-hub':      () => <AgentHubView />,
    'trade-timeline': () => <TradeTimelineView portfolio={portfolio} />,
    'agentic-os':     () => <AgenticOSView />,
    'dcf-valuation':  () => <DCFView onAnalyze={navigateToAnalyze} />,
    'pattern-finder': () => <PatternFinderView onAnalyze={navigateToAnalyze} />,
    'dividend-screen': () => <DividendView onAnalyze={navigateToAnalyze} />,
    'admin':          () => <AdminDashboard />,
  }

  const renderView = views[activeTab] ?? views['dashboard']

  // Show portfolio setup wizard for new authenticated users with no portfolios
  const showWizard = isAuthenticated && !loadingPortfolios && portfolios.length === 0 && !wizardDone

  if (showWizard) {
    return (
      <Suspense fallback={<LoadingScreen fullScreen />}>
        <PortfolioSetupWizard
          onComplete={() => { setWizardDone(true); navigate('dashboard') }}
        />
      </Suspense>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#060810' }}>
      {/* ── Sidebar ── */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={navigateTo}
        triggeredCount={alertsHook.triggered.length}
        onSignIn={onSignIn}
        mobileOpen={mobileNav}
        onMobileClose={() => setMobileNav(false)}
      />

      {/* ── Right column: top-bar + scrollable content ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Slim top bar (ticker + hamburger + ⌘K) */}
        <Header
          onMobileMenuOpen={() => setMobileNav(true)}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        {/* Scrollable main content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="max-w-screen-2xl mx-auto w-full px-4 py-6"
          >
            <Suspense fallback={<LoadingScreen />}>
              {renderView()}
            </Suspense>
          </motion.div>
          </AnimatePresence>

          <footer className="border-t border-white/[0.04] py-4 px-6">
            <div className="max-w-screen-2xl mx-auto flex items-center justify-between text-xs text-slate-600">
              <span>FinSurf v2.0 · Real-time US Equity Platform</span>
              <span>Data via Yahoo Finance · Not financial advice</span>
            </div>
          </footer>
        </main>
      </div>

      {/* ── Command palette (⌘K) ── */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigateTo}
      />

      {/* ── FinSurf Copilot — floating agentic AI panel ── */}
      <Suspense fallback={null}>
        <FinSurfCopilot
          portfolio={portfolio.positions}
          watchlist={watchlist.symbols}
        />
      </Suspense>
    </div>
  )
}

// ── Root export ───────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ProModeProvider>
      <ApiKeysProvider>
        <TooltipProvider>
          <ToastProvider>
            <AuthProvider>
              <AppInner />
            </AuthProvider>
          </ToastProvider>
        </TooltipProvider>
      </ApiKeysProvider>
    </ProModeProvider>
  )
}
