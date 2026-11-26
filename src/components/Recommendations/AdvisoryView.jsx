import { useState, useCallback, useRef } from 'react'
import { Brain, Shield, Target, Flame, Leaf, Search } from 'lucide-react'
import { fmt, fmtPct, fmtLarge, fetchSummary, fetchChart } from '../../services/api'
import { SectionCard, LoadingPulse } from '../shared/StockCard'
import { searchSymbol } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { PERSONA_WEIGHTS, scoreFor } from '../../../lib/persona-rules.js'

const PERSONAS = [
  {
    id: 'growth',
    name: 'Growth Hawk',
    icon: Flame,
    color: '#f59e0b',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-400',
    desc: 'Aggressive growth — high-risk, high-reward momentum plays',
    style: 'Focuses on revenue growth >20%, expanding margins, and strong momentum signals.',
    weights: PERSONA_WEIGHTS.growth,
  },
  {
    id: 'value',
    name: 'Value Seeker',
    icon: Target,
    color: '#10b981',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-400',
    desc: 'Buffett-style deep value — underpriced quality businesses',
    style: 'Low P/E, strong free cash flow, durable moat, dividend track record.',
    weights: PERSONA_WEIGHTS.value,
  },
  {
    id: 'momentum',
    name: 'Momentum Trader',
    icon: TrendingUp2,
    color: '#6366f1',
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    text: 'text-indigo-400',
    desc: 'Technical momentum — ride the trend until it bends',
    style: 'Looks for strong RSI (40–70), price above SMA50, and positive MACD crossover.',
    weights: PERSONA_WEIGHTS.momentum,
  },
  {
    id: 'defensive',
    name: 'Defensive Shield',
    icon: Shield,
    color: '#3b82f6',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    text: 'text-blue-400',
    desc: 'Capital preservation — low volatility, steady dividends',
    style: 'Low beta, a strong balance sheet (ROE, debt/equity), consistent dividends. Judged on risk-adjusted return and lower volatility — not on beating a rising market.',
    weights: PERSONA_WEIGHTS.defensive,
  },
  {
    id: 'esg',
    name: 'ESG Conscious',
    icon: Leaf,
    color: '#00ffcc',
    bg: 'bg-mint-500/10',
    border: 'border-mint-500/20',
    text: 'text-mint-400',
    desc: 'Sustainable investing — quality companies with responsible practices',
    style: 'Financial quality and stability only — this app has no ESG ratings feed, so check MSCI or Sustainalytics yourself before treating a call here as ESG-screened.',
    weights: PERSONA_WEIGHTS.esg,
  },
]

function TrendingUp2(props) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  )
}

// ETF/fund: no pe, no revenueGrowth, no earningsGrowth from fundamentals
function isEtfLike(summary) {
  return summary != null && summary.pe == null && summary.revenueGrowth == null && summary.earningsGrowth == null
}

// The score itself lives in lib/persona-rules.js, shared with the five-year
// test of each persona (lib/persona-rule-study.js), so both score alike.
function scoreForPersona(persona, summary, chartData) {
  const closes = (chartData || []).map(c => c.close)
  if (!summary) return scoreFor(persona.weights, null, closes)
  const f = isEtfLike(summary)
    ? { etf: true, beta: summary.beta, dividendYield: summary.dividendYield, low52: summary.low52, high52: summary.high52 }
    : {
        revenueGrowthPct: summary.revenueGrowth != null ? summary.revenueGrowth * 100 : null,
        earningsGrowthPct: summary.earningsGrowth != null ? summary.earningsGrowth * 100 : null,
        pe: summary.pe, lossMaking: summary.eps != null && summary.eps < 0,
        beta: summary.beta, dividendYield: summary.dividendYield,
        roePct: summary.returnOnEquity != null ? summary.returnOnEquity * 100 : null,
        // Providers differ: a ratio (0.8) or a percent (80). Anything over 10 is read as a percent.
        debtToEquity: summary.debtToEquity == null ? null : summary.debtToEquity > 10 ? summary.debtToEquity / 100 : summary.debtToEquity,
      }
  return scoreFor(persona.weights, f, closes)
}

/**
 * Inputs the score could not see. scoreForPersona treats each as neutral
 * (no points either way) — said on the card, so a score built on half the data
 * does not read like one built on all of it.
 */
function missingInputs(persona, summary, chartData) {
  const w = persona.weights, out = []
  if (!summary) return ['fundamentals']
  if (isEtfLike(summary)) {
    if (summary.beta == null && w.stability > 0) out.push('beta')
    if (summary.dividendYield == null && w.valuation > 0) out.push('dividend yield')
    if ((summary.low52 == null || summary.high52 == null) && w.momentum > 0) out.push('52-week range')
  } else {
    if (summary.revenueGrowth == null && w.revenueGrowth > 0) out.push('revenue growth')
    if (summary.earningsGrowth == null && w.earningsGrowth > 0) out.push('earnings growth')
    if (summary.pe == null && w.valuation > 0) out.push('P/E')
    if (summary.beta == null && w.stability > 0) out.push('beta')
    if (w.quality > 0 && summary.returnOnEquity == null && summary.debtToEquity == null) out.push('ROE and debt/equity')
  }
  if ((chartData?.length ?? 0) <= 20 && w.momentum > 0) out.push('price momentum (too little history)')
  return out
}

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

/** A persona's measured record from /api/advisory-engine/persona-calibration. */
function PersonaRecord({ cal, minSample, signedIn }) {
  if (!signedIn) return <p className="text-[11px] text-slate-500">Sign in to see how this persona's calls have actually done.</p>
  if (!cal) return <p className="text-[11px] text-slate-500">Loading the measured record…</p>
  const line = (side, label) => {
    const c = cal[side]
    if (!c?.recorded) return <div key={side} className="text-slate-500">{label}: none recorded yet.</div>
    if (!c.sufficient) return <div key={side} className="text-slate-500">{label}: uncalibrated — {c.n ?? 0} of {minSample} scored ({c.recorded} recorded).</div>
    return (
      <div key={side} className="text-slate-300">
        {label}: <span className="font-mono text-white">{c.wins} of {c.nScored}</span> right after a week — {pct(c.winRate)} (95%: {pct(c.winRateLo)}–{pct(c.winRateHi)})
        {c.alphaWinRate != null ? `; ${pct(c.alphaWinRate)} beat the market` : ''}.
      </div>
    )
  }
  return (
    <div className="text-[11px] space-y-0.5">
      {line('long', 'Buy / Overweight calls')}
      {line('short', 'Sell / Underweight calls')}
    </div>
  )
}

/** Five-year point-in-time test of a persona's rule (lib/persona-rule-study.js). */
const STUDY_TXT = {
  outperforms:     ['text-emerald-400', 'its top fifth beat the list'],
  underperforms:   ['text-red-400', 'its top fifth did WORSE than the list'],
  'no-difference': ['text-slate-300', 'no measurable difference from the list'],
  insufficient:    ['text-slate-500', 'too few months to judge'],
}
function PersonaStudyLine({ r }) {
  if (!r) return null
  const [cls, txt0] = STUDY_TXT[r.verdict] || ['text-slate-400', r.verdict]
  if (r.objective === 'risk-adjusted') {
    const txt = r.verdict === 'outperforms' ? 'beat the list after allowing for its lower risk'
      : r.verdict === 'underperforms' ? 'did worse than its lower risk explains'
        : r.verdict === 'insufficient' ? txt0 : 'no measurable edge once its lower risk is allowed for'
    return (
      <span>
        <span className={cls}>{txt}</span>
        {r.alphaPct != null && <> — {r.alphaPct > 0 ? '+' : ''}{r.alphaPct}% a month beyond its beta of {r.betaToList} to the list (t {r.alphaT}); {Math.round((1 - r.volRatio) * 100)}% {r.volRatio < 1 ? 'less' : 'more'} volatile; worst fall {r.maxDrawdownPct}% vs the list's {r.listMaxDrawdownPct}%. Raw excess {r.meanExcessPct}% a month.</>}
      </span>
    )
  }
  const txt = txt0
  return (
    <span>
      <span className={cls}>{txt}</span>
      {r.meanExcessPct != null && <> — {r.meanExcessPct > 0 ? '+' : ''}{r.meanExcessPct}% a month vs all names{r.t != null ? ` (t ${r.t})` : ''}, ahead in {Math.round((r.hitRate ?? 0) * 100)}% of {r.periods} months; older half {r.olderHalfPct}%, newer half {r.newerHalfPct}%</>}
    </span>
  )
}
/** Admin-only: start the five-year test now (about a minute), else it runs Saturdays. */
function RunStudyNow({ study, onRun, starting, error }) {
  const running = study?.run?.running
  return (
    <div className="flex items-center gap-2 flex-wrap text-[10px]">
      <button type="button" onClick={onRun} disabled={running || starting}
        className="px-2 py-1 rounded-lg border border-slate-500/25 text-slate-300 hover:text-mint-400 disabled:opacity-50 disabled:cursor-not-allowed">
        {running ? 'Running…' : starting ? 'Starting…' : 'Run now'}
      </button>
      <span className="text-slate-500">
        {running ? `Started ${new Date(study.run.startedAt).toLocaleTimeString()} — about a minute; this updates when it finishes.`
          : 'Admin only. Re-scores five years of data with no AI call.'}
      </span>
      {(error || study?.run?.error) && <span className="text-amber-400">Last run failed: {error || study.run.error}</span>}
    </div>
  )
}

function PersonaStudy({ study, personaId, signedIn, isAdmin, onRun, starting, runError }) {
  if (!signedIn) return <p className="text-[11px] text-slate-500">Sign in to see this persona tested on five years of data.</p>
  if (!study) return <p className="text-[11px] text-slate-500">Loading the five-year test…</p>
  const runner = isAdmin ? <RunStudyNow study={study} onRun={onRun} starting={starting} error={runError} /> : null
  if (study.pending) return <div className="space-y-1.5"><p className="text-[11px] text-slate-500">{study.run?.running ? 'The first run is in progress…' : study.note}</p>{runner}</div>
  return (
    <div className="text-[11px] text-slate-400 space-y-1">
      {runner}
      <div><PersonaStudyLine r={study.personas?.[personaId]} /></div>
      {study.v1?.[personaId] && (
        <div className="text-[10px] text-slate-500">Old score (before it was bounded): {STUDY_TXT[study.v1[personaId].verdict]?.[1] || study.v1[personaId].verdict}, {study.v1[personaId].meanExcessPct}% a month vs the list; top-fifth cut tied in {study.v1[personaId].tiedCutMonths} of {study.v1[personaId].periods} months (now {study.personas?.[personaId]?.tiedCutMonths ?? '—'}).</div>
      )}
      <p className="text-[10px] text-slate-500">Every month of the last five years, {study.universe} large caps were scored with this persona's own rule from SEC figures as first filed and prices up to that day; its top fifth was held a month against all of them, after costs. Run {String(study.ranAt).slice(0, 10)}. {study.caveats?.[0]} {study.caveats?.[1]}</p>
    </div>
  )
}

function personaRecommendation(persona, score, summary) {
  // No fundamentals at all: only the price-based persona can make a call. The
  // others used to say Buy or Sell off momentum alone — a call resting on data
  // they never saw, which the measured record would then score.
  if (!summary && persona.id !== 'momentum') {
    return { action: 'Hold', rationale: 'No fundamentals were available for this symbol, so this persona makes no call.' }
  }
  const pe   = summary?.pe ?? null
  const beta = summary?.beta ?? 1
  const rg   = (summary?.revenueGrowth ?? 0) * 100
  const dy   = (summary?.dividendYield ?? 0) * 100
  const etf  = isEtfLike(summary)

  if (etf) {
    // ── ETF-specific recommendations ──────────────────────────────────────
    if (persona.id === 'growth') {
      if (score >= 68) return { action: 'Overweight', rationale: `Strong price momentum — ETF is near 52-week highs with bullish technical setup. Suitable for growth allocation.` }
      if (score >= 52) return { action: 'Buy', rationale: `Moderate upside momentum. Reasonable entry for a core growth position.` }
      if (score >= 38) return { action: 'Hold', rationale: `Sideways momentum. Wait for a technical breakout before adding.` }
      return { action: 'Underweight', rationale: `Weak momentum signals. Consider waiting for trend recovery above key moving averages.` }
    }
    if (persona.id === 'value') {
      if (dy > 3 && score >= 55) return { action: 'Buy', rationale: `High dividend yield (${dy.toFixed(1)}%) with stable trend. Good income-focused ETF position.` }
      if (dy > 1.5 && score >= 45) return { action: 'Buy', rationale: `Decent yield (${dy.toFixed(1)}%) with positive momentum. Solid all-weather ETF holding.` }
      if (score >= 48) return { action: 'Hold', rationale: `Low-yield ETF. Suitable only as a growth holding, not a value/income play.` }
      return { action: 'Underweight', rationale: `Below-average trend and minimal yield. Look for higher-conviction entry.` }
    }
    if (persona.id === 'momentum') {
      if (score >= 65) return { action: 'Buy', rationale: `Strong price momentum — RSI healthy and price above key moving averages. Ride the trend.` }
      if (score >= 48) return { action: 'Hold', rationale: `Mixed momentum. Set a price alert — enter on confirmed breakout above resistance.` }
      return { action: 'Sell', rationale: `Weak trend. ETF below key moving averages. Wait for momentum confirmation.` }
    }
    if (persona.id === 'defensive') {
      if (beta < 0.7 && score >= 55) return { action: 'Buy', rationale: `Low beta (${fmt(beta, 2)}) ETF with stable trend. Excellent defensive allocation.` }
      if (beta < 1.0) return { action: 'Hold', rationale: `Moderate defensiveness (beta ${fmt(beta, 2)}). Suitable as a partial hedge in volatile markets.` }
      return { action: 'Underweight', rationale: `High beta (${fmt(beta, 2)}) for a defensive allocation. Consider bond or utility ETFs instead.` }
    }
    if (persona.id === 'esg') {
      if (score >= 60) return { action: 'Buy', rationale: `Strong trend with reasonable yield. Check the fund's ESG screening methodology for alignment.` }
      if (score >= 45) return { action: 'Hold', rationale: `Neutral setup. Verify ESG ratings (MSCI, Sustainalytics) before increasing allocation.` }
      return { action: 'Hold', rationale: `Weak trend. Many ESG ETFs have lower volatility — this one needs more investigation.` }
    }
    return { action: 'Hold', rationale: 'Insufficient data for a strong conviction.' }
  }

  // ── Stock recommendations (existing logic) ────────────────────────────────
  if (persona.id === 'growth') {
    if (score >= 70) return { action: 'Buy', rationale: `High revenue growth (${rg.toFixed(1)}%) with strong momentum. Growth profile aligns well.` }
    if (score >= 50) return { action: 'Buy', rationale: `Moderate growth potential. Consider position sizing based on risk tolerance.` }
    if (score >= 35) return { action: 'Hold', rationale: `Growth slowing or valuation stretched. Watch for re-acceleration signals.` }
    return { action: 'Sell', rationale: `Does not meet growth criteria. Below-average revenue and earnings momentum.` }
  }
  if (persona.id === 'value') {
    if (pe != null && pe < 15 && score >= 60) return { action: 'Buy', rationale: `Low P/E (${fmt(pe)}×) with solid fundamentals. Classic value opportunity.` }
    if (pe != null && pe < 25 && score >= 50) return { action: 'Buy', rationale: `Reasonably valued at ${fmt(pe)}× earnings. Margin of safety present.` }
    if (pe != null && pe < 35) return { action: 'Hold', rationale: `Fairly valued. Wait for a better entry below ${fmt(pe * 0.85, 0)}×.` }
    if (pe == null) return { action: 'Hold', rationale: `No P/E available, so there is no value call to make.` }
    return { action: 'Sell', rationale: `Expensive at ${fmt(pe)}× earnings. Value investors would require a significant pullback.` }
  }
  if (persona.id === 'momentum') {
    if (score >= 65) return { action: 'Buy', rationale: `Strong technical momentum. Price above key moving averages with healthy RSI.` }
    if (score >= 45) return { action: 'Hold', rationale: `Mixed momentum signals. Set alerts for a breakout above resistance.` }
    return { action: 'Sell', rationale: `Weak momentum. Price below key moving averages — wait for trend reversal.` }
  }
  if (persona.id === 'defensive') {
    if (beta < 0.8 && score >= 55) return { action: 'Buy', rationale: `Low beta (${fmt(beta, 2)}) with stable earnings. Excellent defensive holding.` }
    if (beta < 1.1) return { action: 'Hold', rationale: `Moderate defensiveness. Suitable as a partial hedge position.` }
    return { action: 'Underweight', rationale: `Higher volatility (beta ${fmt(beta, 2)}) than ideal for defensive allocation.` }
  }
  if (persona.id === 'esg') {
    if (score >= 60) return { action: 'Buy', rationale: `Strong financial profile. No ESG ratings are loaded here — verify the ESG case separately before relying on this.` }
    if (score >= 45) return { action: 'Hold', rationale: `Adequate profile. Research ESG ratings from MSCI or Sustainalytics for conviction.` }
    return { action: 'Hold', rationale: `Financial metrics need improvement. ESG leadership requires both financial and sustainability quality.` }
  }
  return { action: 'Hold', rationale: 'Insufficient data for strong conviction.' }
}

function taxAdvice(summary) {
  const advice = []
  const pe = summary?.pe
  const rg = (summary?.revenueGrowth || 0) * 100
  const dy = (summary?.dividendYield || 0) * 100

  if (dy > 2) {
    advice.push({ type: 'Dividend', tip: `${dy.toFixed(1)}% yield — hold in tax-advantaged accounts (IRA/401k) to defer dividend taxes.`, priority: 'high' })
  }
  advice.push({ type: 'Holding Period', tip: 'Hold > 1 year to qualify for long-term capital gains rate (0%, 15%, or 20% vs. ordinary income).', priority: 'medium' })
  if (rg > 20) {
    advice.push({ type: 'Tax-Loss Harvest', tip: 'High growth stocks can be volatile. Consider tax-loss harvesting pairs with similar ETFs during drawdowns.', priority: 'medium' })
  }
  advice.push({ type: 'Wash Sale Rule', tip: '30-day rule: avoid repurchasing same/substantially identical security within 30 days of selling at a loss.', priority: 'info' })
  if (pe && pe > 50) {
    advice.push({ type: 'Concentrated Risk', tip: 'High valuation stocks have higher drawdown risk. Consider options collars to limit downside tax exposure.', priority: 'medium' })
  }
  return advice
}

export default function AdvisoryView({ portfolio }) {
  const [symbol, setSymbol] = useState('')
  const [inputVal, setInputVal] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [showResults, setShowResults] = useState(false)
  const [summary, setSummary] = useState(null)
  const [chartData, setChartData] = useState([])
  const [scores, setScores] = useState({})
  const [recommendations, setRecommendations] = useState({})
  const [taxTips, setTaxTips] = useState([])
  const [loading, setLoading] = useState(false)
  const [activePersona, setActivePersona] = useState('growth')
  const [missing, setMissing] = useState({})
  // The measured half (server): each persona's directional call is recorded on a
  // server price and scored a week later; the record per persona comes back here.
  const { authFetch, isAuthenticated, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [personaStudy, setPersonaStudy] = useState(null)
  const personaStudyRef = useRef(null)
  const [studyStarting, setStudyStarting] = useState(false)
  const [studyRunError, setStudyRunError] = useState(null)
  const loadStudy = useCallback(() => authFetch('/api/advisory-engine/persona-study').then(r => r.json())
    .then(d => { if (!d.error) { personaStudyRef.current = d; setPersonaStudy(d) } return d }).catch(() => null), [authFetch])
  const runStudy = useCallback(async () => {
    setStudyStarting(true); setStudyRunError(null)
    try {
      const r = await authFetch('/api/advisory-engine/persona-study/run', { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok && r.status !== 409) throw new Error(d.error || `HTTP ${r.status}`)
      // Poll until the run finishes, then show the new study.
      for (let i = 0; i < 60; i++) {
        const cur = await loadStudy()
        if (cur && !cur.run?.running) break
        await new Promise(res => setTimeout(res, 5000))
      }
    } catch (e) { setStudyRunError(e.message) } finally { setStudyStarting(false) }
  }, [authFetch, loadStudy])
  const [personaCal, setPersonaCal] = useState(null)

  const analyze = useCallback(async (sym) => {
    setLoading(true)
    try {
      const [sum, chart] = await Promise.all([
        fetchSummary(sym),
        fetchChart(sym, '1d', '6mo').catch(() => ({ candles: [] }))
      ])
      setSummary(sum)
      setChartData(chart.candles || [])
      const sc = {}, rec = {}, miss = {}
      for (const p of PERSONAS) {
        sc[p.id] = scoreForPersona(p, sum, chart.candles || [])
        rec[p.id] = personaRecommendation(p, sc[p.id], sum)
        miss[p.id] = missingInputs(p, sum, chart.candles || [])
      }
      setScores(sc)
      setRecommendations(rec)
      setMissing(miss)
      setTaxTips(taxAdvice(sum))
      if (isAuthenticated) {
        // Best-effort: recording or reading the record never blocks the page.
        authFetch('/api/advisory-engine/persona-record', {
          method: 'POST',
          body: { symbol: sym, calls: PERSONAS.map(p => ({ persona: p.id, action: rec[p.id]?.action, score: sc[p.id], missing: miss[p.id] })) },
        }).catch(() => {})
        authFetch('/api/advisory-engine/persona-calibration').then(r => r.json()).then(d => { if (!d.error) setPersonaCal(d) }).catch(() => {})
        if (!personaStudyRef.current) authFetch('/api/advisory-engine/persona-study').then(r => r.json()).then(d => { if (!d.error) { personaStudyRef.current = d; setPersonaStudy(d) } }).catch(() => {})
      }
    } catch (e) { console.warn(e) }
    setLoading(false)
  }, [isAuthenticated])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = async (q) => {
    setInputVal(q)
    if (!q.trim()) { setSearchResults([]); return }
    const r = await searchSymbol(q).catch(() => [])
    setSearchResults(r)
    setShowResults(true)
  }

  const handleSelect = (sym) => {
    setSymbol(sym)
    setInputVal(sym)
    setSearchResults([])
    setShowResults(false)
    analyze(sym)
  }

  const activeP = PERSONAS.find(p => p.id === activePersona)
  const taxColors = { high: 'text-amber-400', medium: 'text-blue-400', info: 'text-slate-400' }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={inputVal}
            onChange={e => handleSearch(e.target.value)}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Analyze any stock or ETF — e.g. NVDA, SPY, QQQ…"
            className="input pl-9 uppercase"
          />
          {showResults && searchResults.length > 0 && (
            <div className="absolute top-full mt-1 w-full z-20 glass rounded-lg border border-white/[0.08] overflow-hidden">
              {searchResults.map(r => (
                <button key={r.symbol} onMouseDown={() => handleSelect(r.symbol)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.06] text-left text-sm transition-colors">
                  <span className="font-mono text-mint-400 font-semibold w-12 shrink-0">{r.symbol}</span>
                  <span className="text-slate-300 truncate">{r.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Brain className="w-4 h-4 text-mint-400" />
        <span className="text-sm text-slate-400">5-Persona AI Advisory Engine</span>
      </div>

      {loading && <div className="glass rounded-xl p-6"><LoadingPulse rows={5} /></div>}

      {!loading && Object.keys(scores).length > 0 && (
        <div className="grid lg:grid-cols-3 gap-4">
          {/* Persona selector */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Select Advisor</h3>
            {PERSONAS.map(p => {
              const Icon = p.icon
              const s = scores[p.id] || 0
              const rec = recommendations[p.id]
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePersona(p.id)}
                  className={`w-full text-left glass-card border transition-all
                    ${activePersona === p.id ? `${p.bg} ${p.border}` : 'border-transparent hover:border-white/[0.08]'}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${p.bg}`}>
                      <Icon className={`w-4 h-4 ${p.text}`} style={{ color: p.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-white">{p.name}</span>
                        <span className={`text-xs font-semibold ${p.text}`}>{rec?.action}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="flex-1 bg-white/[0.06] rounded-full h-1">
                          <div className="h-1 rounded-full transition-all" style={{ width: `${s}%`, background: p.color }} />
                        </div>
                        <span className="text-[10px] font-mono text-slate-500 w-7" title="Fit score from hand-set weights — not a probability">{s}</span>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Active persona detail */}
          <div className="lg:col-span-2 space-y-4">
            {activeP && (
              <>
                <div className={`glass rounded-xl p-5 border ${activeP.border}`}>
                  <div className="flex items-start gap-4 mb-4">
                    <div className={`p-3 rounded-xl ${activeP.bg}`}>
                      <activeP.icon className="w-6 h-6" style={{ color: activeP.color }} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white">{activeP.name}</h3>
                      <p className="text-sm text-slate-400 mt-0.5">{activeP.desc}</p>
                    </div>
                    <div className="ml-auto text-right">
                      <div className={`text-2xl font-bold font-mono ${activeP.text}`}>{scores[activeP.id]}</div>
                      <div className="text-xs text-slate-500">Fit score / 100</div>
                      <div className="text-[10px] text-slate-600">hand-set weights, not a forecast</div>
                    </div>
                  </div>

                  <div className="glass rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${activeP.bg} ${activeP.border} ${activeP.text}`}>
                        {recommendations[activeP.id]?.action}
                      </span>
                      <span className="text-xs text-slate-400">for {symbol}</span>
                    </div>
                    <p className="text-sm text-slate-300 leading-relaxed">{recommendations[activeP.id]?.rationale}</p>
                  </div>

                  {missing[activeP.id]?.length > 0 && (
                    <p className="text-[11px] text-amber-400 mb-2">Scored without: {missing[activeP.id].join(', ')} — each counted as neutral.</p>
                  )}

                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 mb-3">
                    <div className="text-[11px] font-semibold text-slate-300 mb-1">How {activeP.name}'s calls have done</div>
                    <PersonaRecord cal={personaCal?.byPersona?.[activeP.id]} minSample={personaCal?.minSample ?? 8} signedIn={isAuthenticated} />
                    <p className="text-[10px] text-slate-500 mt-1">Every Buy, Overweight, Sell or Underweight call on this page is recorded at the last close and scored a week later. Hold is not scored.</p>
                  </div>
                  <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 mb-3">
                    <div className="text-[11px] font-semibold text-slate-300 mb-1">{activeP.name}'s rule over the last five years</div>
                    <PersonaStudy study={personaStudy} personaId={activeP.id} signedIn={isAuthenticated} isAdmin={isAdmin} onRun={runStudy} starting={studyStarting} runError={studyRunError} />
                  </div>

                  <div className="text-xs text-slate-500 italic">Strategy: {activeP.style}</div>
                </div>

                {/* Fundamentals summary */}
                {summary && (() => {
                  const etf = isEtfLike(summary)
                  const rows = etf
                    ? [
                        { label: 'Beta', value: summary.beta ? fmt(summary.beta, 2) : '—' },
                        { label: 'Div Yield', value: summary.dividendYield ? fmtPct(summary.dividendYield * 100) : '—' },
                        { label: '52W High', value: summary.high52 ? `$${fmt(summary.high52)}` : '—' },
                        { label: '52W Low', value: summary.low52 ? `$${fmt(summary.low52)}` : '—' },
                        { label: 'Avg Volume', value: summary.avgVolume ? fmtLarge(summary.avgVolume) : '—' },
                        { label: 'Market Cap', value: summary.marketCap ? fmtLarge(summary.marketCap) : '—' },
                      ]
                    : [
                        { label: 'P/E', value: summary.pe ? fmt(summary.pe) + '×' : '—' },
                        { label: 'EPS', value: summary.eps ? `$${fmt(summary.eps)}` : '—' },
                        { label: 'Beta', value: summary.beta ? fmt(summary.beta, 2) : '—' },
                        { label: 'Rev Growth', value: summary.revenueGrowth ? fmtPct(summary.revenueGrowth * 100) : '—' },
                        { label: 'Profit Margin', value: summary.profitMargin ? fmtPct(summary.profitMargin * 100) : '—' },
                        { label: 'Div Yield', value: summary.dividendYield ? fmtPct(summary.dividendYield * 100) : '—' },
                      ]
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {rows.map(s => (
                        <div key={s.label} className="glass-card">
                          <div className="stat-label">{s.label}</div>
                          <div className="text-base font-mono font-semibold text-white mt-0.5">{s.value}</div>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        </div>
      )}

      {/* Tax-aware recommendations */}
      {taxTips.length > 0 && (
        <SectionCard title="Tax-Aware Recommendations">
          <div className="grid sm:grid-cols-2 gap-3">
            {taxTips.map((tip, i) => (
              <div key={i} className="glass rounded-lg p-3">
                <div className={`text-xs font-semibold mb-1 ${taxColors[tip.priority]}`}>{tip.type}</div>
                <div className="text-xs text-slate-400 leading-relaxed">{tip.tip}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {!loading && !symbol && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Brain className="w-10 h-10 text-mint-400 opacity-60" />
          <div className="text-base font-semibold text-white">5-Persona Advisory Engine</div>
          <div className="text-sm text-slate-500 max-w-md">
            Search for any stock or ETF to see how five rule-based investment personas — Growth Hawk, Value Seeker,
            Momentum Trader, Defensive Shield and ESG Conscious — would read it. Each uses fixed, hand-set weights;
            every call is recorded and scored, so each persona's real hit rate builds up over time.
          </div>
          <div className="mt-2 space-y-2">
            <div className="text-[10px] text-slate-600 uppercase tracking-wider">Stocks</div>
            <div className="flex flex-wrap gap-2 justify-center">
              {['AAPL', 'MSFT', 'NVDA', 'TSLA', 'XOM', 'JPM'].map(s => (
                <button key={s} onClick={() => handleSelect(s)}
                  className="px-3 py-1.5 text-xs glass-card border border-white/[0.08] text-mint-400 font-mono hover:border-mint-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-slate-600 uppercase tracking-wider mt-1">ETFs</div>
            <div className="flex flex-wrap gap-2 justify-center">
              {['SPY', 'QQQ', 'VTI', 'SCHD', 'GLD', 'TLT'].map(s => (
                <button key={s} onClick={() => handleSelect(s)}
                  className="px-3 py-1.5 text-xs glass-card border border-white/[0.08] text-purple-400 font-mono hover:border-purple-500/30 transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
