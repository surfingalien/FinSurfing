import { useState, useMemo } from 'react'
import Header from './components/Layout/Header'
import PortfolioView from './components/Portfolio/PortfolioView'
import WatchlistView from './components/Watchlist/WatchlistView'
import AnalysisView from './components/Analysis/AnalysisView'
import AdvisoryView from './components/Recommendations/AdvisoryView'
import SimulationView from './components/MonteCarlo/SimulationView'
import ScreenerView from './components/Screener/ScreenerView'
import StrategiesView from './components/Strategies/StrategiesView'
import AlertsView from './components/Alerts/AlertsView'
import ResearchView from './components/Research/ResearchView'
import { usePortfolio } from './hooks/usePortfolio'
import { useWatchlist } from './hooks/useWatchlist'
import { useAlerts } from './hooks/useAlerts'

export default function App() {
  const [activeTab, setActiveTab]       = useState('portfolio')
  const [analyzeSymbol, setAnalyzeSymbol] = useState('AAPL')
  const portfolio = usePortfolio()
  const watchlist = useWatchlist()

  // Merge portfolio + watchlist quotes into one map for alert checking
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

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        triggeredCount={alertsHook.triggered.length}
      />

      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-4 py-6">
        {activeTab === 'portfolio' && (
          <PortfolioView portfolio={portfolio} />
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
          <ResearchView
            portfolioSymbols={portfolio.positions.map(p => p.symbol)}
            watchlistSymbols={watchlist.symbols}
          />
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
