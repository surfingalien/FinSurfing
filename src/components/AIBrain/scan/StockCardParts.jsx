import { motion } from 'motion/react'
import { GitFork, Lock } from 'lucide-react'

/* ── ScoreBar ──────────────────────────────────────────────── */
export function ScoreBar({ agent, score, conflictAgents = [] }) {
  const Icon = agent.icon
  const pct  = Math.min(100, Math.max(0, score))
  const barColor = pct >= 75 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
  const inConflict = conflictAgents.includes(agent.label)
  return (
    <div className={`flex items-center gap-2 ${inConflict ? 'ring-1 ring-amber-500/30 rounded px-1 -mx-1' : ''}`}>
      <div className={`flex items-center gap-1 w-[82px] shrink-0 ${agent.color}`}>
        <Icon className="w-3 h-3 shrink-0" />
        <span className="text-[10px] font-medium">{agent.label}</span>
        {inConflict && <span className="text-amber-400 text-[9px] ml-0.5">⚡</span>}
      </div>
      <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400 w-6 text-right">{score}</span>
    </div>
  )
}

/* ── CompositeRing ─────────────────────────────────────────── */
export function CompositeRing({ score }) {
  const r    = 20
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  const color = score >= 75 ? '#34d399' : score >= 55 ? '#fbbf24' : '#f87171'
  return (
    <div className="relative w-14 h-14 shrink-0">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-black text-white">{score}</span>
    </div>
  )
}

/* ── ConflictBanner ─────────────────────────────────────────── */
export function ConflictBanner({ conflict }) {
  if (!conflict?.exists || conflict.spread < 25) return null
  const severity = conflict.spread >= 40 ? 'high' : 'medium'
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-start gap-3 p-3 rounded-xl border text-xs ${
        severity === 'high'
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          : 'bg-blue-500/8 border-blue-500/20 text-blue-300'
      }`}
    >
      <GitFork className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${severity === 'high' ? 'text-amber-400' : 'text-blue-400'}`} />
      <div className="min-w-0">
        <span className={`font-bold ${severity === 'high' ? 'text-amber-400' : 'text-blue-400'}`}>
          Agent Conflict ({conflict.spread}pt spread):
        </span>{' '}
        <span className="font-medium">{conflict.agents?.[0]} vs {conflict.agents?.[1]}</span>
        {conflict.meaning && <span className="text-slate-400"> — {conflict.meaning}</span>}
      </div>
    </motion.div>
  )
}

/* ── PriceZones ────────────────────────────────────────────── */
export function PriceZones({ stock }) {
  const plan = stock.tradePlan
  if (plan) return <TradePlan plan={stock.tradePlan} stock={stock} />

  // Older cached scans predate tradePlan.
  if (stock.actionable === false) {
    return (
      <div className="mt-3 rounded-xl px-3 py-2.5 bg-slate-500/10 border border-slate-400/20">
        <div className="text-[11px] font-semibold text-slate-300">No entry, target or stop</div>
        <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">
          The Brain does not recommend buying this. Run a new scan for reference levels.
        </div>
      </div>
    )
  }

  const hasZones = stock.entryZoneLow || stock.entryZoneHigh
  const hasFallback = stock.entryPrice
  if (!hasZones && !hasFallback) return null

  const fmt = (v) => v ? `$${Number(v).toFixed(2)}` : null

  if (hasZones) {
    return (
      <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
        <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
          <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry Zone</div>
          <div className="text-[10px] font-mono font-bold text-white leading-tight">
            {fmt(stock.entryZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.entryZoneHigh)}
          </div>
        </div>
        <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
          <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Target Zone</div>
          <div className="text-[10px] font-mono font-bold text-emerald-400 leading-tight">
            {fmt(stock.targetZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.targetZoneHigh)}
          </div>
        </div>
        <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
          <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop Zone</div>
          <div className="text-[10px] font-mono font-bold text-red-400 leading-tight">
            {fmt(stock.stopZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.stopZoneHigh)}
          </div>
        </div>
      </div>
    )
  }

  // Fallback to legacy exact prices (older responses)
  return (
    <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
      <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
        <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry</div>
        <div className="text-[11px] font-mono font-bold text-white">{fmt(stock.entryPrice)}</div>
      </div>
      <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
        <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Target</div>
        <div className="text-[11px] font-mono font-bold text-emerald-400">{fmt(stock.takeProfitPrice)}</div>
      </div>
      <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
        <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop</div>
        <div className="text-[11px] font-mono font-bold text-red-400">{fmt(stock.stopLossPrice)}</div>
      </div>
    </div>
  )
}

/* ── TradePlan ──────────────────────────────────────────────
 * Entry range, stop range and two profit-booking levels, computed by the
 * server from real prices (lib/trade-levels.js). For a pick the Brain
 * declined, these are technical reference levels — said plainly on the card.
 */
const money = v => (v == null ? '—' : `$${Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toPrecision(4)}`)
const range = (lo, hi) => `${money(lo)} – ${money(hi)}`

export function TradePlan({ plan, stock }) {
  const reference = plan.basis === 'technical'
  return (
    <div className={`mt-3 rounded-xl p-2.5 border ${reference ? 'bg-slate-500/5 border-slate-400/20' : 'bg-blue-500/5 border-blue-500/15'}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={`text-[10px] font-semibold ${reference ? 'text-slate-400' : 'text-blue-400'}`}>
          {reference ? 'Reference levels — not a buy signal' : 'Trade plan'}
        </span>
        {stock?.currentPrice != null && (
          <span className="text-[9px] text-slate-500">
            {money(stock.currentPrice)} · {stock.priceSource || 'price'}{stock.priceAsOf ? ` ${stock.priceAsOf}` : ''}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[10px]">
        <div className="rounded-lg p-1.5 bg-blue-500/10 border border-blue-500/20">
          <div className="text-[9px] text-blue-400 font-medium">Entry range</div>
          <div className="font-mono font-bold text-white">{range(plan.entry.low, plan.entry.high)}</div>
        </div>
        <div className="rounded-lg p-1.5 bg-red-500/10 border border-red-500/20">
          <div className="text-[9px] text-red-400 font-medium">Stop loss (−{plan.riskPct}%)</div>
          <div className="font-mono font-bold text-red-400">{range(plan.stop.low, plan.stop.high)}</div>
        </div>
        {plan.booking.map(b => (
          <div key={b.label} className="rounded-lg p-1.5 bg-emerald-500/10 border border-emerald-500/20">
            <div className="text-[9px] text-emerald-400 font-medium">{b.label} (+{b.pct}%, {b.r}R)</div>
            <div className="font-mono font-bold text-emerald-400">{range(b.low, b.high)}</div>
          </div>
        ))}
      </div>
      {reference && (
        <p className="text-[9px] text-slate-500 mt-1.5 leading-snug">
          {stock?.actionable === false ? 'The Brain declined this pick. ' : ''}These levels come from price action alone (recent support and the average daily range, ATR {money(plan.atr)}) — where a setup would start, not a recommendation.
        </p>
      )}
      {plan.notes?.map((n, i) => <p key={i} className="text-[9px] text-amber-400 mt-1 leading-snug">⚠ {n}</p>)}
    </div>
  )
}

/* ── ThesisAssumptions ─────────────────────────────────────── */
export function ThesisAssumptions({ assumptions }) {
  if (!assumptions?.length) return null
  return (
    <div className="rounded-xl p-3 bg-indigo-500/8 border border-indigo-500/20">
      <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold text-indigo-400">
        <Lock className="w-3 h-3" />
        Bull Case Assumptions
        <span className="text-[9px] text-slate-500 font-normal ml-1">— thesis breaks if these fail</span>
      </div>
      <ul className="space-y-1">
        {assumptions.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
            <span className="text-indigo-500 shrink-0 mt-0.5 font-mono">{i + 1}.</span>
            <span>{a}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
