import { useState } from 'react'
import { BookOpen, TrendingUp, BarChart2, Layers, Zap } from 'lucide-react'
import { SectionCard } from '../shared/StockCard'

const STRATEGIES = [
  {
    id: 'trend',
    name: 'Trend Following',
    icon: TrendingUp,
    color: '#00ffcc',
    description: 'Trade in the direction of the prevailing trend using moving average crossovers.',
    rules: [
      'Enter LONG when 20-day EMA crosses above 50-day EMA (Golden Cross)',
      'Enter SHORT when 20-day EMA crosses below 50-day EMA (Death Cross)',
      'Confirm with volume > 30-day average',
      'Set stop-loss 2× ATR below entry',
      'Trail stop as price advances',
    ],
    pros: ['Works well in trending markets', 'Clear entry/exit rules', 'Good risk/reward potential'],
    cons: ['Whipsaws in ranging markets', 'Late entries — misses early move', 'Requires patience'],
    timeframe: 'Daily / Weekly',
    riskLevel: 'Medium',
    indicators: ['EMA20', 'EMA50', 'Volume', 'ATR'],
  },
  {
    id: 'meanrev',
    name: 'Mean Reversion',
    icon: BarChart2,
    color: '#6366f1',
    description: 'Buy oversold assets expecting a bounce back to average levels.',
    rules: [
      'Buy when RSI(14) drops below 30 (oversold)',
      'Sell when RSI(14) rises above 70 (overbought)',
      'Price must touch or breach lower Bollinger Band',
      'Confirm with positive divergence on MACD',
      'Risk 1–2% of capital per trade',
    ],
    pros: ['High win rate in sideways markets', 'Clear signals from RSI/Bollinger', 'Works in most conditions'],
    cons: ['Dangerous in strong downtrends', 'Catching falling knives risk', 'Timing is difficult'],
    timeframe: 'Daily',
    riskLevel: 'Medium-High',
    indicators: ['RSI(14)', 'Bollinger Bands', 'MACD'],
  },
  {
    id: 'breakout',
    name: 'Breakout Strategy',
    icon: Zap,
    color: '#f59e0b',
    description: 'Enter when price breaks through key support/resistance with high volume.',
    rules: [
      'Identify consolidation period (base) of 3–8 weeks',
      'Enter on close above resistance with volume 1.5× average',
      'Place stop-loss just below the breakout level',
      'Target: height of base pattern above breakout point',
      'Watch for false breakouts — require 2-day confirmation',
    ],
    pros: ['Can catch explosive moves', 'Clear invalidation levels', 'Used by top growth investors'],
    cons: ['High false-positive rate', 'Requires volume confirmation', 'Can miss entry on gaps'],
    timeframe: 'Daily / Weekly',
    riskLevel: 'High',
    indicators: ['Volume', 'Price Action', 'ATR', 'RSI'],
  },
  {
    id: 'momentum',
    name: 'Momentum (RS)',
    icon: Layers,
    color: '#ec4899',
    description: 'Buy stocks with the strongest relative strength vs. the S&P 500.',
    rules: [
      'Rank S&P 500 stocks by 6-month relative strength',
      'Long top 20% of universe each month',
      'Rebalance monthly',
      'Exit any position that drops out of top 30%',
      'Hedge with SPY puts during market corrections (VIX > 25)',
    ],
    pros: ['Historically strong long-term returns', 'Systematic and objective', 'Diversified approach'],
    cons: ['Large drawdowns during reversals', 'High turnover and transaction costs', 'Momentum crashes'],
    timeframe: 'Monthly rebalance',
    riskLevel: 'Medium',
    indicators: ['Relative Strength', 'RS Rating', 'VIX'],
  },
  {
    id: 'dividend',
    name: 'Dividend Growth',
    icon: BookOpen,
    color: '#10b981',
    description: 'Build income by compounding dividends from quality businesses that grow payouts.',
    rules: [
      '10+ consecutive years of dividend growth',
      'Payout ratio < 60%',
      'Dividend yield > 1.5% (not too high)',
      'Earnings growth > 5% CAGR over 5 years',
      'Reinvest all dividends (DRIP)',
    ],
    pros: ['Passive income generation', 'Lower volatility', 'Tax-efficient (qualified dividends)'],
    cons: ['Slower capital appreciation', 'Limited to dividend-paying stocks', 'Interest rate sensitivity'],
    timeframe: 'Long-term (5+ years)',
    riskLevel: 'Low-Medium',
    indicators: ['Dividend Yield', 'Payout Ratio', 'EPS Growth'],
  },
]

const RISK_COLORS = {
  'Low-Medium': 'text-emerald-400',
  'Medium': 'text-amber-400',
  'Medium-High': 'text-orange-400',
  'High': 'text-red-400',
}

export default function StrategiesView({ onAnalyze }) {
  const [active, setActive] = useState('trend')
  const s = STRATEGIES.find(x => x.id === active)

  return (
    <div className="grid lg:grid-cols-4 gap-4 animate-fade-in">
      {/* Strategy list */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Trading Strategies</h3>
        {STRATEGIES.map(st => {
          const Icon = st.icon
          return (
            <button
              key={st.id}
              onClick={() => setActive(st.id)}
              className={`w-full text-left glass-card border transition-all
                ${active === st.id ? 'border-white/[0.15] bg-white/[0.06]' : 'border-transparent'}`}
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-white/[0.05]">
                  <Icon className="w-4 h-4" style={{ color: st.color }} />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{st.name}</div>
                  <div className={`text-[10px] ${RISK_COLORS[st.riskLevel]}`}>Risk: {st.riskLevel}</div>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Strategy detail */}
      {s && (
        <div className="lg:col-span-3 space-y-4">
          <div className="glass rounded-xl p-5">
            <div className="flex items-start gap-4 mb-4">
              <div className="p-3 rounded-xl bg-white/[0.05]">
                <s.icon className="w-6 h-6" style={{ color: s.color }} />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-white">{s.name}</h2>
                <p className="text-sm text-slate-400 mt-0.5">{s.description}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-slate-500">{s.timeframe}</div>
                <div className={`text-xs font-semibold ${RISK_COLORS[s.riskLevel]}`}>Risk: {s.riskLevel}</div>
              </div>
            </div>

            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Indicators</h4>
              <div className="flex flex-wrap gap-2">
                {s.indicators.map(ind => (
                  <span key={ind} className="px-2.5 py-1 rounded-full text-xs border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 font-medium">
                    {ind}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Entry/Exit Rules</h4>
              <ol className="space-y-2">
                {s.rules.map((rule, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                      style={{ background: `${s.color}20`, color: s.color }}>
                      {i + 1}
                    </span>
                    <span className="text-slate-300 leading-relaxed">{rule}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <SectionCard title="Advantages">
              <ul className="space-y-2 mt-1">
                {s.pros.map((pro, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-emerald-400 mt-0.5">✓</span>
                    <span className="text-slate-300">{pro}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
            <SectionCard title="Limitations">
              <ul className="space-y-2 mt-1">
                {s.cons.map((con, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-red-400 mt-0.5">✗</span>
                    <span className="text-slate-300">{con}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>

          <div className="glass rounded-xl p-4 text-center">
            <p className="text-sm text-slate-400 mb-3">Apply this strategy in Technical Analysis</p>
            <button onClick={() => onAnalyze?.('AAPL')} className="btn-primary">
              Open Analysis Chart →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
