/**
 * LandingPage — marketing page shown before authentication.
 *
 * Light, high-contrast design system:
 *   canvas   #FFFFFF          · alternating sections #F9FAFB
 *   headings #0F172A (slate-900) · body #475569 (slate-600)
 *   accent   #2563EB (blue-600) — reserved for CTAs, interactive state, and
 *            key highlights only, so it never loses its meaning
 *   borders  slate-200 hairlines + soft, multi-layered low-opacity shadows
 *
 * Motion is subtle by design: scroll-reveal fades and small hover lifts,
 * all disabled under prefers-reduced-motion (handled globally in index.css).
 */
import { useState, useEffect, useRef } from 'react'
import {
  TrendingUp, Shield, Zap, BarChart2, Brain, Bell,
  Search, PieChart, Activity, ArrowRight, Star, Play,
  Check, Sparkles, Lock, LineChart,
} from 'lucide-react'

/* ── Scroll reveal ──────────────────────────────────────────
   IntersectionObserver rather than a scroll listener: it fires off the main
   thread, so a long page of reveals doesn't cost scroll smoothness. */
function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // If IO is unavailable, show immediately — never hide content behind a
    // capability check.
    if (typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setShown(true); io.disconnect() } },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      } ${className}`}
    >
      {children}
    </div>
  )
}

/* ── Content ────────────────────────────────────────────── */
const BENTO = {
  primary: {
    icon: Brain,
    title: 'AI Brain that learns from its own record',
    desc: 'Five agents score every candidate, then a supervisor surfaces where they disagree — because the disagreement is the signal. Every pick is logged and scored against real prices at +7, +30 and +90 days.',
    bullets: ['Contradiction engine', 'Benchmark-relative scoring', 'Calibrated confidence'],
  },
  secondary: [
    { icon: TrendingUp, title: 'Real-time portfolio', desc: 'Live P&L, cost basis, day change and allocation across every account.' },
    { icon: BarChart2,  title: 'Deep technicals',     desc: 'RSI, MACD, Bollinger, Ichimoku and Supertrend on 1D–5Y timeframes.' },
  ],
  tertiary: [
    { icon: Activity, title: 'Backtesting',    desc: 'Validate a strategy on real bars before you risk anything.' },
    { icon: PieChart, title: 'Multi-account',  desc: 'Brokerage, Roth, 401(k) and crypto in one view.' },
    { icon: Search,   title: 'Screener',       desc: 'Filter by 20+ fundamentals and momentum.' },
    { icon: Bell,     title: 'Price alerts',   desc: 'Entry-zone and threshold triggers.' },
  ],
}

const METRICS = [
  { value: '50+',   label: 'Live indicators' },
  { value: '90d',   label: 'Forecast horizon' },
  { value: '1,000', label: 'Monte Carlo paths' },
  { value: '11',    label: 'Account types' },
]

const TESTIMONIALS = [
  { quote: 'The advisory flagged a reversal in my tech holdings three days before the drop. The signal quality is genuinely different.', name: 'Sarah K.', role: 'Retail investor' },
  { quote: 'The Monte Carlo retirement sim is the clearest I have seen. It changed how I think about safe withdrawal rates.', name: 'Marcus T.', role: 'Financial planner' },
  { quote: 'Finally a portfolio tracker that does not phone home with my data. The security model actually holds up.', name: 'Alex R.', role: 'Software engineer' },
]

const TRUST = ['Yahoo Finance', 'Finnhub', 'FRED', 'SEC EDGAR', 'Polygon']

/* ── Brand ──────────────────────────────────────────────── */
function Logo({ dark = false }) {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8" aria-hidden="true">
        <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4 22 L10 14 L16 18 L22 8 L28 12" stroke="#2563EB" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.12" />
        <circle cx="16" cy="18" r="2.5" fill="#0F172A" />
      </svg>
      <span className="font-bold text-xl tracking-tight">
        <span className={dark ? 'text-white' : 'text-slate-900'}>FIN</span>
        <span className="text-blue-600">SURF</span>
      </span>
    </div>
  )
}

/* ── App preview ────────────────────────────────────────────
   A real-looking product shot rather than a stock image: the numbers are the
   ones the app actually renders, so the hero doesn't promise a UI that
   doesn't exist. */
function AppPreview() {
  const bars = [40, 45, 38, 55, 50, 60, 58, 65, 62, 70, 68, 75, 72, 80, 78, 88]
  const holdings = [
    { s: 'NVDA', v: '+4.87%', up: true },
    { s: 'AAPL', v: '+2.14%', up: true },
    { s: 'MSFT', v: '+0.63%', up: true },
    { s: 'TSLA', v: '−1.22%', up: false },
  ]

  return (
    <div className="relative mx-auto max-w-4xl">
      {/* Diffused glow — depth without a hard drop shadow */}
      <div
        aria-hidden="true"
        className="absolute -inset-x-8 -inset-y-6 rounded-[2rem] blur-3xl opacity-40"
        style={{ background: 'radial-gradient(60% 60% at 50% 40%, rgba(37,99,235,0.22), transparent 70%)' }}
      />

      <div className="relative rounded-2xl border border-slate-200 bg-white overflow-hidden
                      shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-8px_rgba(15,23,42,0.12),0_40px_80px_-24px_rgba(15,23,42,0.16)]">
        {/* Window chrome */}
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-slate-200 bg-slate-50">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
          <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
          <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
          <div className="flex-1 mx-4 h-6 rounded-md bg-white border border-slate-200 flex items-center px-3">
            <Lock size={9} className="text-slate-400 mr-1.5" />
            <span className="text-[10px] text-slate-400">finsurf.app/dashboard</span>
          </div>
        </div>

        {/* Product nav */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-200 bg-white overflow-hidden">
          <Logo />
          <div className="hidden sm:flex gap-1 ml-3">
            {['Dashboard', 'Portfolio', 'AI Brain', 'Analyze', 'Backtest'].map((t, i) => (
              <span
                key={t}
                className={`px-2.5 py-1 rounded-md text-[10px] font-medium ${
                  i === 0 ? 'text-blue-700 bg-blue-50 ring-1 ring-blue-100' : 'text-slate-500'
                }`}
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3 bg-slate-50">
          <div className="col-span-2 rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Portfolio value</div>
            <div className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">$142,847.32</div>
            <div className="text-[11px] font-medium text-emerald-600 mt-0.5 tabular-nums">▲ $1,247.18 (+0.88%) today</div>
            <div className="mt-4 flex items-end gap-1 h-14" aria-hidden="true">
              {bars.map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-all"
                  style={{
                    height: `${h}%`,
                    background: i === bars.length - 1 ? '#2563EB' : `rgba(37,99,235,${0.12 + i * 0.045})`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-white border border-slate-200 p-4 flex flex-col items-center justify-center shadow-sm">
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">Fear &amp; Greed</div>
            <div className="text-3xl font-bold text-slate-900 mt-1 tabular-nums">68</div>
            <div className="text-[10px] font-semibold text-amber-600">Greed</div>
            <svg viewBox="0 0 60 34" className="w-16 mt-2" aria-hidden="true">
              <path d="M5 30 A25 25 0 0 1 55 30" fill="none" stroke="#E2E8F0" strokeWidth="5" strokeLinecap="round" />
              <path d="M5 30 A25 25 0 0 1 41 9" fill="none" stroke="#F59E0B" strokeWidth="5" strokeLinecap="round" />
            </svg>
          </div>

          {holdings.map(h => (
            <div key={h.s} className="rounded-xl bg-white border border-slate-200 p-3 shadow-sm">
              <div className="text-xs font-semibold text-slate-900">{h.s}</div>
              <div className={`text-[11px] font-medium tabular-nums ${h.up ? 'text-emerald-600' : 'text-rose-600'}`}>
                {h.v}
              </div>
            </div>
          ))}

          <div className="rounded-xl bg-white border border-slate-200 p-3 shadow-sm flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <Brain size={14} className="text-blue-600" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-slate-900 truncate">AI Brain</div>
              <div className="text-[10px] text-slate-500 truncate">12 picks scored</div>
            </div>
          </div>

          <div className="rounded-xl bg-white border border-slate-200 p-3 shadow-sm flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
              <LineChart size={14} className="text-emerald-600" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-slate-900 truncate">Backtest</div>
              <div className="text-[10px] text-slate-500 truncate">Alpha +12.4%</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Page ───────────────────────────────────────────────── */
export default function LandingPage({ onSignIn, onRegister, onTryDemo }) {
  const [scrolled, setScrolled] = useState(false)

  // Only the nav's elevation depends on scroll, so a passive listener with a
  // boolean guard is enough — no layout reads, no rAF loop.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="landing-root min-h-screen bg-white text-slate-600 antialiased selection:bg-blue-100 selection:text-blue-900">

      {/* ── Nav ── */}
      <header
        className={`sticky top-0 z-50 border-b transition-all duration-300 ${
          scrolled
            ? 'bg-white/80 backdrop-blur-xl border-slate-200 shadow-[0_1px_3px_rgba(15,23,42,0.04)]'
            : 'bg-white/60 backdrop-blur-md border-transparent'
        }`}
      >
        <nav className="max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-6 h-16">
          <Logo />
          <div className="hidden md:flex items-center gap-8">
            {[['Features', '#features'], ['How it works', '#how-it-works'], ['Reviews', '#reviews']].map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
              >
                {label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={onSignIn}
              className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
            >
              Sign in
            </button>
            <button
              onClick={onRegister}
              className="px-4 sm:px-5 py-2 rounded-full text-sm font-semibold text-white bg-blue-600
                         hover:bg-blue-700 shadow-sm hover:shadow-md hover:-translate-y-px
                         active:translate-y-0 transition-all duration-200
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              Get started
            </button>
          </div>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        {/* Soft ambient wash — light, never muddy */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div
            className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[900px] h-[600px] opacity-[0.55]"
            style={{ background: 'radial-gradient(50% 50% at 50% 50%, rgba(37,99,235,0.10), transparent 70%)' }}
          />
        </div>

        <div className="relative max-w-4xl mx-auto px-5 sm:px-6 pt-16 sm:pt-24 pb-12 text-center">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                            border border-slate-200 bg-white text-slate-600 text-xs font-medium shadow-sm">
              <Sparkles size={12} className="text-blue-600" />
              No ads. No upsells. Your data stays yours.
            </div>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="mt-6 text-4xl sm:text-6xl font-bold tracking-tight text-slate-900 leading-[1.08]">
              Your portfolio,{' '}
              <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-transparent">
                amplified
              </span>{' '}
              by AI
            </h1>
          </Reveal>

          <Reveal delay={140}>
            <p className="mt-5 text-lg text-slate-600 max-w-xl mx-auto leading-relaxed">
              The stock intelligence platform built around what you actually own —
              with an AI that measures its own track record instead of asking you to trust it.
            </p>
          </Reveal>

          <Reveal delay={200}>
            <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={onTryDemo}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5
                           rounded-full text-base font-semibold text-white bg-blue-600 hover:bg-blue-700
                           shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_24px_-6px_rgba(37,99,235,0.45)]
                           hover:shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_32px_-6px_rgba(37,99,235,0.55)]
                           hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
                <Zap size={17} />
                Try the live demo
              </button>
              <button
                onClick={onRegister}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5
                           rounded-full text-base font-semibold text-slate-700 bg-white
                           border border-slate-200 hover:border-slate-300 hover:bg-slate-50
                           shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0
                           transition-all duration-200
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
              >
                <Play size={15} className="text-blue-600" />
                Create free account
              </button>
            </div>
            <p className="mt-4 text-xs text-slate-500">Free forever · No credit card · Guest mode available</p>
          </Reveal>
        </div>

        <Reveal delay={260}>
          <div className="relative px-5 sm:px-6 pb-16 sm:pb-20">
            <AppPreview />
          </div>
        </Reveal>
      </section>

      {/* ── Trust bar ── */}
      <section className="border-y border-slate-200 bg-slate-50/60">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 py-8">
          <p className="text-center text-xs font-medium uppercase tracking-widest text-slate-400 mb-6">
            Powered by institutional data sources
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {TRUST.map(name => (
              <span
                key={name}
                className="text-sm font-semibold text-slate-400 grayscale hover:text-slate-600
                           transition-colors duration-200"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Bento feature grid ── */}
      <section id="features" className="max-w-6xl mx-auto px-5 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
              Everything you need to invest smarter
            </h2>
            <p className="mt-4 text-slate-600 leading-relaxed">
              Built for people who want to see the reasoning, not just the recommendation.
            </p>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Primary tile */}
          <Reveal className="lg:col-span-2">
            <article className="group h-full rounded-2xl border border-slate-200 bg-white p-7 sm:p-9
                                shadow-[0_1px_2px_rgba(15,23,42,0.04)]
                                hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_16px_40px_-12px_rgba(15,23,42,0.14)]
                                hover:-translate-y-1 hover:border-slate-300 transition-all duration-300">
              <span className="inline-flex w-11 h-11 rounded-xl bg-blue-50 items-center justify-center
                               group-hover:scale-105 transition-transform duration-300">
                <BENTO.primary.icon size={22} className="text-blue-600" />
              </span>
              <h3 className="mt-5 text-xl font-semibold text-slate-900">{BENTO.primary.title}</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">{BENTO.primary.desc}</p>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
                {BENTO.primary.bullets.map(b => (
                  <li key={b} className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <Check size={15} className="text-blue-600 shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
            </article>
          </Reveal>

          {/* Secondary stack */}
          <div className="grid gap-4">
            {BENTO.secondary.map((f, i) => (
              <Reveal key={f.title} delay={60 + i * 60}>
                <article className="group h-full rounded-2xl border border-slate-200 bg-slate-50 p-6
                                    hover:bg-white hover:border-slate-300
                                    hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-10px_rgba(15,23,42,0.12)]
                                    hover:-translate-y-1 transition-all duration-300">
                  <span className="inline-flex w-10 h-10 rounded-xl bg-white border border-slate-200
                                   items-center justify-center group-hover:scale-105 transition-transform duration-300">
                    <f.icon size={19} className="text-blue-600" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">{f.title}</h3>
                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">{f.desc}</p>
                </article>
              </Reveal>
            ))}
          </div>

          {/* Tertiary row — its own 4-up sub-grid spanning the full width, so
              the four cards land as one clean row instead of orphaning one. */}
          <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {BENTO.tertiary.map((f, i) => (
              <Reveal key={f.title} delay={i * 60}>
                <article className="group h-full rounded-2xl border border-slate-200 bg-white p-6
                                    shadow-[0_1px_2px_rgba(15,23,42,0.03)]
                                    hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-10px_rgba(15,23,42,0.12)]
                                    hover:-translate-y-1 hover:border-slate-300 transition-all duration-300">
                  <span className="inline-flex w-10 h-10 rounded-xl bg-slate-50 items-center justify-center
                                   group-hover:bg-blue-50 transition-colors duration-300">
                    <f.icon size={19} className="text-slate-500 group-hover:text-blue-600 transition-colors duration-300" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">{f.title}</h3>
                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">{f.desc}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Metrics ── */}
      <section className="border-y border-slate-200 bg-slate-50">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 py-14">
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            {METRICS.map((m, i) => (
              <Reveal key={m.label} delay={i * 70}>
                <div className="text-center">
                  <dt className="sr-only">{m.label}</dt>
                  <dd>
                    <div className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 tabular-nums">
                      {m.value}
                    </div>
                    <div className="mt-1.5 text-sm text-slate-600">{m.label}</div>
                  </dd>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-5 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
              Get started in 60 seconds
            </h2>
            <p className="mt-4 text-slate-600">No setup call, no onboarding funnel, no credit card.</p>
          </div>
        </Reveal>

        <div className="grid sm:grid-cols-3 gap-6">
          {[
            { step: '01', title: 'Create an account', desc: 'Free forever. Email and password, or jump straight in as a guest.' },
            { step: '02', title: 'Add your holdings', desc: 'Type tickers and share counts, or import a CSV. Nothing leaves your account.' },
            { step: '03', title: 'Get scored insight', desc: 'The AI scores every position, forecasts ahead, and flags risk — then grades itself.' },
          ].map(({ step, title, desc }, i) => (
            <Reveal key={step} delay={i * 90}>
              <div className="relative h-full rounded-2xl border border-slate-200 bg-white p-7
                              shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl
                                 bg-blue-600 text-white text-sm font-bold tabular-nums shadow-sm">
                  {step}
                </span>
                <h3 className="mt-5 text-base font-semibold text-slate-900">{title}</h3>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">{desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section id="reviews" className="border-t border-slate-200 bg-slate-50">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-20 sm:py-24">
          <Reveal>
            <h2 className="text-center text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 mb-14">
              Trusted by people who read the fine print
            </h2>
          </Reveal>
          <div className="grid sm:grid-cols-3 gap-5">
            {TESTIMONIALS.map(({ quote, name, role }, i) => (
              <Reveal key={name} delay={i * 80}>
                <figure className="h-full rounded-2xl border border-slate-200 bg-white p-6
                                   shadow-[0_1px_2px_rgba(15,23,42,0.03)]
                                   hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-10px_rgba(15,23,42,0.12)]
                                   hover:-translate-y-1 transition-all duration-300">
                  <div className="flex gap-0.5" aria-label="5 out of 5 stars">
                    {[...Array(5)].map((_, s) => (
                      <Star key={s} size={13} className="text-amber-400 fill-amber-400" />
                    ))}
                  </div>
                  <blockquote className="mt-4 text-sm text-slate-600 leading-relaxed">
                    &ldquo;{quote}&rdquo;
                  </blockquote>
                  <figcaption className="mt-5 pt-4 border-t border-slate-100">
                    <div className="text-sm font-semibold text-slate-900">{name}</div>
                    <div className="text-xs text-slate-500">{role}</div>
                  </figcaption>
                </figure>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing CTA ── */}
      <section className="max-w-4xl mx-auto px-5 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white
                          px-8 py-14 sm:px-14 sm:py-16 text-center
                          shadow-[0_1px_2px_rgba(15,23,42,0.04),0_24px_60px_-20px_rgba(15,23,42,0.18)]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{ background: 'radial-gradient(60% 80% at 50% 0%, rgba(37,99,235,0.08), transparent 70%)' }}
            />
            <div className="relative">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
                Ready to surf the market?
              </h2>
              <p className="mt-4 text-slate-600">
                Free account. No subscription. Every feature unlocked.
              </p>
              <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  onClick={onTryDemo}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5
                             rounded-full text-base font-semibold text-white bg-blue-600 hover:bg-blue-700
                             shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_24px_-6px_rgba(37,99,235,0.45)]
                             hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  <Zap size={17} />
                  Try the demo
                </button>
                <button
                  onClick={onSignIn}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5
                             rounded-full text-base font-semibold text-slate-700 bg-white
                             border border-slate-200 hover:border-slate-300 hover:bg-slate-50
                             shadow-sm hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
                >
                  Sign in
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-14">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-1">
              <Logo />
              <p className="mt-4 text-sm text-slate-600 leading-relaxed max-w-xs">
                Stock intelligence that shows its work — and keeps score of it.
              </p>
              <div className="mt-5 flex items-center gap-2 text-xs font-medium text-slate-500">
                <Shield size={13} className="text-emerald-600" />
                Zero tracking · Your data stays yours
              </div>
            </div>

            {[
              { heading: 'Product',  links: ['Features', 'How it works', 'Reviews', 'Live demo'] },
              { heading: 'Data',     links: ['Yahoo Finance', 'Finnhub', 'FRED macro', 'SEC EDGAR'] },
            ].map(({ heading, links }) => (
              <div key={heading}>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-900">{heading}</h3>
                <ul className="mt-4 space-y-2.5">
                  {links.map(l => (
                    <li key={l}>
                      <span className="text-sm text-slate-600 hover:text-slate-900 transition-colors cursor-default">
                        {l}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-900">Stay in the loop</h3>
              <p className="mt-4 text-sm text-slate-600">Occasional product notes. No spam, ever.</p>
              <form
                className="mt-4 flex gap-2"
                onSubmit={(e) => e.preventDefault()}
              >
                <label htmlFor="newsletter-email" className="sr-only">Email address</label>
                <input
                  id="newsletter-email"
                  type="email"
                  placeholder="you@example.com"
                  className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm
                             text-slate-900 placeholder:text-slate-400 shadow-sm
                             focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20
                             transition-all"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white
                             hover:bg-slate-800 shadow-sm transition-colors
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                >
                  Join
                </button>
              </form>
            </div>
          </div>

          <div className="mt-12 pt-8 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-xs text-slate-500">© {new Date().getFullYear()} FinSurf · Not financial advice.</p>
            <div className="flex items-center gap-5 text-xs text-slate-500">
              <span className="hover:text-slate-900 transition-colors cursor-default">Privacy</span>
              <span className="hover:text-slate-900 transition-colors cursor-default">Terms</span>
              <span className="hover:text-slate-900 transition-colors cursor-default">Open source</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
