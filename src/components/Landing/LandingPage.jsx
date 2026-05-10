/**
 * LandingPage — marketing / demo page shown before the user authenticates.
 * Dark glassmorphism design, mint #00ffcc accent, matches the app theme.
 */
import { useState } from 'react'
import {
  TrendingUp, Shield, Zap, BarChart2, Brain, Bell,
  Search, PieChart, Activity, ArrowRight, Star,
  ChevronRight, Globe,
} from 'lucide-react'

// ── Feature data ──────────────────────────────────
const FEATURES = [
  {
    icon: TrendingUp,
    color: '#00ffcc',
    title: 'Real-Time Portfolio Tracking',
    desc: 'Live prices via Yahoo Finance. P&L, day change, cost basis, and allocation — all in one view.',
  },
  {
    icon: Brain,
    color: '#6366f1',
    title: 'AI-Powered Advisory',
    desc: '5-factor ensemble ML model scores every holding. Bull/bear probability, Fibonacci levels, 90-day forecasts.',
  },
  {
    icon: BarChart2,
    color: '#f59e0b',
    title: 'Interactive Charts',
    desc: 'OHLCV candle charts with RSI, MACD, Bollinger Bands. Multiple timeframes from 1D to 5Y.',
  },
  {
    icon: PieChart,
    color: '#ec4899',
    title: 'Multi-Portfolio Management',
    desc: 'Brokerage, Roth IRA, 401(k), crypto, and more — track all your accounts from one dashboard.',
  },
  {
    icon: Activity,
    color: '#10b981',
    title: 'Monte Carlo Retirement Sim',
    desc: 'Run 1,000 simulations to project your retirement date with confidence intervals and safe withdrawal rates.',
  },
  {
    icon: Search,
    color: '#3b82f6',
    title: 'Stock Screener',
    desc: 'Filter thousands of stocks by P/E, market cap, momentum, sector, and 20+ fundamental metrics.',
  },
  {
    icon: Bell,
    color: '#f97316',
    title: 'Price Alerts',
    desc: 'Get notified when any stock crosses your target price. Set triggers for price, % change, or volume.',
  },
  {
    icon: Shield,
    color: '#8b5cf6',
    title: 'Bank-Grade Security',
    desc: 'OWASP-compliant auth. JWT access tokens in memory, HTTP-only refresh cookies, bcrypt passwords.',
  },
]

const STATS = [
  { value: '50+',   label: 'Live indicators',  icon: Activity },
  { value: '11',    label: 'Portfolio types',   icon: PieChart  },
  { value: '90d',   label: 'AI price forecasts',icon: Brain     },
  { value: '1K+',   label: 'Monte Carlo sims',  icon: TrendingUp},
]

const SCREENSHOTS = [
  { label: 'Dashboard',  color: '#00ffcc', desc: 'Fear & Greed index, sector heatmap, market movers' },
  { label: 'AI Advisory',color: '#6366f1', desc: 'ML signals, Fibonacci levels, chart insights'       },
  { label: 'Screener',   color: '#f59e0b', desc: 'Filter stocks by 20+ fundamental metrics'            },
  { label: 'Retirement', color: '#10b981', desc: 'Monte Carlo simulation with safe withdrawal rates'   },
]

// ── Sub-components ────────────────────────────────
function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#00ffcc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12"/>
        <circle cx="16" cy="18" r="2.5" fill="#6366f1"/>
      </svg>
      <span className="font-bold text-xl tracking-tight">
        <span className="text-white">FIN</span>
        <span style={{ color: '#00ffcc' }}>SURF</span>
      </span>
    </div>
  )
}

function FeatureCard({ icon: Icon, color, title, desc }) {
  return (
    <div className="group rounded-2xl p-5 border border-white/[0.06] bg-white/[0.02]
                    hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
        style={{ background: `${color}18` }}
      >
        <Icon size={20} style={{ color }} />
      </div>
      <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
      <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
    </div>
  )
}

function StatBadge({ value, label, icon: Icon }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-4">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="text-xs text-slate-500 text-center">{label}</div>
    </div>
  )
}

// ── Fake "app screenshot" mockup ──────────────────
function AppMockup() {
  return (
    <div className="relative mx-auto max-w-2xl">
      {/* Glow */}
      <div
        className="absolute inset-0 rounded-2xl blur-3xl opacity-20"
        style={{ background: 'linear-gradient(135deg, #00ffcc, #6366f1)' }}
      />

      {/* Window chrome */}
      <div className="relative rounded-2xl border border-white/10 bg-[#0a0e1a] overflow-hidden shadow-2xl">
        {/* Fake tab bar */}
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-[#0d1120]">
          <div className="w-3 h-3 rounded-full bg-red-500/60" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
          <div className="w-3 h-3 rounded-full bg-green-500/60" />
          <div className="flex-1 mx-4 h-6 rounded-md bg-white/[0.04] flex items-center px-3">
            <Globe size={10} className="text-slate-600 mr-2" />
            <span className="text-[10px] text-slate-600">finsurf.app</span>
          </div>
        </div>

        {/* Fake nav */}
        <div className="flex items-center gap-2 px-4 py-2 bg-[#0d1120] border-b border-white/[0.05] overflow-hidden">
          <Logo />
          <div className="flex gap-1 ml-4">
            {['Dashboard', 'Portfolio', 'Analyze', 'Advisory', 'Screener'].map((t, i) => (
              <div
                key={t}
                className={`px-2.5 py-1 rounded text-[10px] font-medium ${
                  i === 0 ? 'text-[#00ffcc] bg-[#00ffcc]/15 border border-[#00ffcc]/25' : 'text-slate-500'
                }`}
              >
                {t}
              </div>
            ))}
          </div>
        </div>

        {/* Fake dashboard content */}
        <div className="p-4 grid grid-cols-3 gap-3">
          {/* Portfolio value card */}
          <div className="col-span-2 rounded-xl bg-white/[0.03] border border-white/[0.06] p-3">
            <div className="text-[10px] text-slate-500 mb-1">Portfolio Value</div>
            <div className="text-lg font-bold text-white">$142,847.32</div>
            <div className="text-[10px] text-emerald-400">▲ $1,247.18 (+0.88%) today</div>
            {/* Fake sparkline */}
            <div className="mt-3 flex items-end gap-0.5 h-10">
              {[40, 45, 38, 55, 50, 60, 58, 65, 62, 70, 68, 75, 72, 80, 78, 85].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm"
                  style={{
                    height: `${h}%`,
                    background: i === 15 ? '#00ffcc' : `rgba(0,255,204,${0.15 + i * 0.04})`,
                  }}
                />
              ))}
            </div>
          </div>

          {/* Fear & Greed */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 flex flex-col items-center justify-center">
            <div className="text-[10px] text-slate-500 mb-1">Fear & Greed</div>
            <div className="text-2xl font-bold text-amber-400">68</div>
            <div className="text-[9px] text-amber-400 font-medium">Greed</div>
            {/* Mini arc */}
            <svg viewBox="0 0 60 34" className="w-14 mt-1">
              <path d="M5 30 A25 25 0 0 1 55 30" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" strokeLinecap="round"/>
              <path d="M5 30 A25 25 0 0 1 41 9" fill="none" stroke="#f59e0b" strokeWidth="5" strokeLinecap="round"/>
            </svg>
          </div>

          {/* Holdings grid */}
          {[
            { s: 'AAPL', v: '+2.14%', c: 'emerald' },
            { s: 'NVDA', v: '+4.87%', c: 'emerald' },
            { s: 'MSFT', v: '+0.63%', c: 'emerald' },
            { s: 'TSLA', v: '-1.22%', c: 'red'     },
            { s: 'SPY',  v: '+0.88%', c: 'emerald' },
            { s: 'BTC',  v: '+3.41%', c: 'emerald' },
          ].map(({ s, v, c }) => (
            <div key={s}
              className={`rounded-lg p-2 border border-${c}-500/20 bg-${c}-500/5 flex flex-col`}>
              <div className="text-[9px] font-bold text-white">{s}</div>
              <div className={`text-[9px] text-${c}-400`}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main Landing Page ─────────────────────────────
export default function LandingPage({ onSignIn, onRegister, onTryDemo }) {
  const [hoveredFeature, setHoveredFeature] = useState(null)

  return (
    <div className="min-h-screen text-white overflow-x-hidden" style={{ background: '#060810' }}>
      {/* ── Ambient background glows ── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-20%] left-[10%] w-[600px] h-[600px] rounded-full opacity-[0.07]"
          style={{ background: 'radial-gradient(circle, #00ffcc, transparent 70%)' }} />
        <div className="absolute top-[30%] right-[-10%] w-[500px] h-[500px] rounded-full opacity-[0.06]"
          style={{ background: 'radial-gradient(circle, #6366f1, transparent 70%)' }} />
        <div className="absolute bottom-[-10%] left-[30%] w-[400px] h-[400px] rounded-full opacity-[0.05]"
          style={{ background: 'radial-gradient(circle, #f59e0b, transparent 70%)' }} />
      </div>

      {/* ── Navbar ── */}
      <nav className="relative z-10 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <Logo />
        <div className="flex items-center gap-3">
          <button
            onClick={onSignIn}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors"
          >
            Sign In
          </button>
          <button
            onClick={onRegister}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-[#0a0e1a]
                       transition-all hover:scale-105"
            style={{ background: '#00ffcc' }}
          >
            Get Started Free
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative z-10 text-center pt-16 pb-20 px-6 max-w-4xl mx-auto">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#00ffcc]/20
                        bg-[#00ffcc]/5 text-[#00ffcc] text-xs font-medium mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00ffcc] animate-pulse" />
          Live market data · AI-powered analysis · Zero ads
        </div>

        <h1 className="text-5xl sm:text-6xl font-black tracking-tight mb-6 leading-tight">
          Your Portfolio,{' '}
          <span style={{ color: '#00ffcc' }}>Amplified</span>{' '}
          by AI
        </h1>

        <p className="text-lg text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Real-time tracking, AI advisory, Monte Carlo retirement sims, and
          a full stock screener — all in one dark, beautiful dashboard.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={onTryDemo}
            className="flex items-center gap-2 px-8 py-3.5 rounded-xl font-bold text-[#0a0e1a]
                       text-base transition-all hover:scale-105 shadow-lg shadow-[#00ffcc]/20"
            style={{ background: 'linear-gradient(135deg, #00ffcc, #00d4aa)' }}
          >
            <Zap size={18} />
            Try Live Demo
          </button>
          <button
            onClick={onRegister}
            className="flex items-center gap-2 px-8 py-3.5 rounded-xl font-semibold text-white text-base
                       border border-white/10 hover:bg-white/5 transition-all"
          >
            Create Free Account
            <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* ── App mockup ── */}
      <section className="relative z-10 px-6 max-w-4xl mx-auto mb-20">
        <AppMockup />
      </section>

      {/* ── Stats ── */}
      <section className="relative z-10 max-w-3xl mx-auto px-6 mb-20">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]
                        grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-white/[0.05]">
          {STATS.map(s => <StatBadge key={s.label} {...s} />)}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 mb-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white mb-3">Everything you need to invest smarter</h2>
          <p className="text-slate-500 text-sm max-w-xl mx-auto">
            Built for serious investors. No fluff, no locked features, no subscription required.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map(f => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 mb-20">
        <div className="rounded-3xl border border-white/[0.06] overflow-hidden"
          style={{ background: 'linear-gradient(135deg, rgba(0,255,204,0.04), rgba(99,102,241,0.04))' }}>
          <div className="p-8 sm:p-12">
            <h2 className="text-2xl font-bold text-white mb-8 text-center">Get started in 60 seconds</h2>
            <div className="grid sm:grid-cols-3 gap-8">
              {[
                { step: '01', title: 'Create Account', desc: 'Free forever. No credit card needed. Email & password or continue as guest.', color: '#00ffcc' },
                { step: '02', title: 'Add Holdings',   desc: 'Type your ticker symbols and share counts. Import from CSV or connect manually.', color: '#6366f1' },
                { step: '03', title: 'Get AI Insights', desc: 'AI scores every position, forecasts 90 days ahead, and flags risk automatically.', color: '#f59e0b' },
              ].map(({ step, title, desc, color }) => (
                <div key={step} className="flex flex-col items-center text-center">
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-lg font-black mb-4"
                    style={{ background: `${color}20`, color }}
                  >
                    {step}
                  </div>
                  <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
                  <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 mb-20">
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { quote: 'The AI advisory caught a reversal in my tech holdings 3 days before the drop. Incredible signal quality.', name: 'Sarah K.', role: 'Retail Investor' },
            { quote: 'Monte Carlo retirement sim is the most visual I\'ve seen. Changed how I think about safe withdrawal.', name: 'Marcus T.', role: 'Financial Planner' },
            { quote: 'Finally a portfolio tracker that doesn\'t phone home with my data. The security model is solid.', name: 'Alex R.', role: 'Software Engineer' },
          ].map(({ quote, name, role }) => (
            <div key={name} className="rounded-2xl p-5 border border-white/[0.06] bg-white/[0.02]">
              <div className="flex gap-0.5 mb-3">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={12} className="text-amber-400 fill-amber-400" />
                ))}
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">&ldquo;{quote}&rdquo;</p>
              <div>
                <div className="text-xs font-semibold text-white">{name}</div>
                <div className="text-[10px] text-slate-600">{role}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="relative z-10 max-w-2xl mx-auto px-6 mb-20 text-center">
        <div className="rounded-3xl border border-[#00ffcc]/15 p-10 sm:p-14"
          style={{ background: 'linear-gradient(135deg, rgba(0,255,204,0.05), rgba(99,102,241,0.05))' }}>
          <h2 className="text-3xl font-bold text-white mb-4">Ready to surf the market?</h2>
          <p className="text-slate-400 text-sm mb-8">
            Free account. No subscriptions. Full feature access.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onTryDemo}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl
                         font-bold text-[#0a0e1a] text-sm transition-all hover:scale-105
                         shadow-lg shadow-[#00ffcc]/20"
              style={{ background: '#00ffcc' }}
            >
              <Zap size={16} />
              Try Demo Now
            </button>
            <button
              onClick={onSignIn}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl
                         font-semibold text-white text-sm border border-white/10 hover:bg-white/5 transition-all"
            >
              Sign In
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="relative z-10 border-t border-white/[0.04] py-8 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Logo />
          <div className="flex items-center gap-6 text-xs text-slate-600">
            <span>Not financial advice</span>
            <span>·</span>
            <span>Data via Yahoo Finance</span>
            <span>·</span>
            <span>OWASP Compliant</span>
          </div>
          <div className="text-xs text-slate-700">© 2025 FinSurf. All rights reserved.</div>
        </div>
      </footer>
    </div>
  )
}
