'use strict'
/**
 * Counting repeat picks once, ranking check, drift alarm and skill scores
 * (ideas from calibrain-harness, MIT).
 */
const cs = require('../lib/calibration-stats')
const bl = require('../lib/brain-learnings')
const sb = require('../lib/shadow-baseline')
const ls = require('../lib/learning-store')
const meta = require('../lib/meta-label')

const DAY = 86_400_000
const T0 = Date.UTC(2025, 0, 1)
const iso = t => new Date(t).toISOString()
function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }

describe('independentPicks', () => {
  it('keeps a stock once per window, per symbol, in original order', () => {
    const rows = [
      { symbol: 'A', generatedAt: iso(T0 + 2 * DAY) },
      { symbol: 'A', generatedAt: iso(T0) },
      { symbol: 'B', generatedAt: iso(T0 + 1 * DAY) },
      { symbol: 'A', generatedAt: iso(T0 + 31 * DAY) },
      { symbol: null, generatedAt: iso(T0) },
    ]
    const kept = cs.independentPicks(rows, 30)
    expect(kept.map(r => `${r.symbol}@${r.generatedAt.slice(5, 10)}`)).toEqual(['A@01-01', 'B@01-02', 'A@02-01', 'null@01-01'])
  })
  it('measures the window from the last KEPT pick, not the last seen one', () => {
    const rows = [0, 20, 40, 60].map(d => ({ symbol: 'A', generatedAt: iso(T0 + d * DAY) }))
    expect(cs.independentPicks(rows, 30).length).toBe(2)   // day 0 and day 40
  })
  it('takes a per-record window', () => {
    const rows = [{ symbol: 'A', generatedAt: iso(T0), d: 7 }, { symbol: 'A', generatedAt: iso(T0 + 10 * DAY), d: 7 }]
    expect(cs.independentPicks(rows, r => r.d).length).toBe(2)
  })
})

describe('spearman / pageHinkley / brierSkill', () => {
  it('spearman: perfect, inverted and too-few', () => {
    const x = Array.from({ length: 20 }, (_, i) => i)
    expect(cs.spearman(x, x).rho).toBe(1)
    expect(cs.spearman(x, x.map(v => -v)).rho).toBe(-1)
    expect(cs.spearman([1, 2, 3], [1, 2, 3]).rho).toBeNull()
  })
  it('spearman handles ties with average ranks', () => {
    expect(cs.ranks([3, 1, 3, 2])).toEqual([3.5, 1, 3.5, 2])
  })
  it('pageHinkley alarms on a shift and not on a constant series', () => {
    expect(cs.pageHinkley(Array(50).fill(0)).alarm).toBe(false)
    const shifted = [...Array(25).fill(0), ...Array(25).fill(1)]
    const r = cs.pageHinkley(shifted, { delta: 0.1, lambda: 3 })
    expect(r.alarm).toBe(true)
    expect(r.alarmAt).toBeGreaterThan(25)
  })
  it('brierSkill: positive for an informative forecast, about zero for the reference itself', () => {
    const r = rng(3), ys = [], good = [], ref = []
    for (let i = 0; i < 400; i++) { const p = r(); const y = r() < p ? 1 : 0; ys.push(y); good.push(p); ref.push(0.5) }
    const s = cs.brierSkill(good, ref, ys)
    expect(s.skill).toBeGreaterThan(0.1)
    expect(s.lo).toBeGreaterThan(0)
    expect(cs.brierSkill(ref, ref, ys).skill).toBe(0)
    expect(cs.brierSkill(good.slice(0, 10), ref.slice(0, 10), ys.slice(0, 10)).skill).toBeNull()
  })
})

describe('computeStats counts repeat picks once', () => {
  const pick = (symbol, day, ret, over = {}) => ({
    symbol, generatedAt: iso(T0 + day * DAY), basePrice: 100, price7d: 100 + ret, benchRet7d: 0, confidence: 'High', entered: true, ...over,
  })
  it('an hourly scan naming one winner forty times is one outcome', () => {
    const recs = [
      ...Array.from({ length: 40 }, (_, i) => pick('NVDA', i / 24, 10)),
      ...Array.from({ length: 10 }, (_, i) => pick(`L${i}`, 1, -5)),
    ]
    const s = bl.computeStats(recs)
    expect(s.h7.nRaw).toBe(50)
    expect(s.h7.nTradeable).toBe(11)
    expect(s.h7.wins).toBe(1)
    expect(s.independence).toMatchObject({ horizon: 7, raw: 50, independent: 11 })
    expect(s.calibration.High.n).toBe(11)
  })
  it('a pick after its window ended counts again', () => {
    const s = bl.computeStats([pick('A', 0, 5), pick('A', 8, 5)])
    expect(s.h7.nTradeable).toBe(2)
  })
})

describe('rankingCheck', () => {
  const make = (n, link, seed) => {
    const r = rng(seed)
    return Array.from({ length: n }, (_, i) => {
      const score = Math.round(30 + r() * 65)
      const ret = link * (score - 60) / 10 + (r() - 0.5) * 8
      return { symbol: `S${i}`, generatedAt: iso(T0 + i * DAY), basePrice: 100, price7d: 100 + ret, benchRet7d: 0, compositeScore: score, confidence: 'Medium', entered: true }
    })
  }
  it('finds a planted score–outcome link', () => {
    const s = bl.computeStats(make(120, 1, 5))
    expect(s.ranking.ready).toBe(true)
    expect(s.ranking.verdict).toBe('ranks')
    expect(s.ranking.metric).toBe('alpha')
    expect(s.ranking.byScore.length).toBeGreaterThan(2)
  })
  it('an inverted score is called inverted', () => {
    expect(bl.computeStats(make(120, -1, 6)).ranking.verdict).toBe('inverted')
  })
  it('noise mostly reads flat', () => {
    let flat = 0
    for (let seed = 1; seed <= 20; seed++) if (bl.computeStats(make(80, 0, seed * 13)).ranking.verdict === 'flat') flat++
    expect(flat).toBeGreaterThanOrEqual(17)
  })
  it('is not ready under 30 picks', () => {
    const r = bl.computeStats(make(20, 1, 2)).ranking
    expect(r.ready).toBe(false)
    expect(r.verdict).toBeUndefined()
  })
})

describe('AI vs random: repeat picks and drift', () => {
  it('compareToShadows counts each stock once per window and reports the raw count', () => {
    const preds = [], shadows = []
    for (let s = 0; s < 30; s++) {
      const at = iso(T0 + s * 3600_000)
      preds.push({ symbol: 'NVDA', generatedAt: at, basePrice: 100, price7d: 110, benchRet7d: 0 })
      shadows.push({ symbol: `R${s}`, generatedAt: at, basePrice: 100, price7d: 95, benchRet7d: 0 })
    }
    const v = sb.compareToShadows(preds, shadows)
    expect(v.rawN).toEqual({ ai: 30, shadow: 30 })
    expect(v.ai.n).toBe(1)
    expect(v.verdict).toBe('insufficient')
  })

  const history = (weeks, aiRate, seed, n = 6) => {
    const r = rng(seed), preds = [], shadows = []
    for (let w = 0; w < weeks; w++) {
      const at = iso(T0 + w * 7 * DAY)
      const pa = typeof aiRate === 'function' ? aiRate(w) : aiRate
      for (let i = 0; i < n; i++) {
        preds.push({ symbol: `A${w}-${i}`, generatedAt: at, basePrice: 100, price7d: r() < pa ? 105 : 95, benchRet7d: 0 })
        shadows.push({ symbol: `R${w}-${i}`, generatedAt: at, basePrice: 100, price7d: r() < 0.5 ? 105 : 95, benchRet7d: 0 })
      }
    }
    return [preds, shadows]
  }
  it('rarely alarms on noise', () => {
    let alarms = 0
    for (let seed = 1; seed <= 40; seed++) if (sb.driftVsRandom(...history(52, 0.5, seed * 7)).alarm) alarms++
    expect(alarms).toBeLessThanOrEqual(4)
  })
  it('alarms when a real lead disappears', () => {
    let alarms = 0
    for (let seed = 1; seed <= 20; seed++) if (sb.driftVsRandom(...history(104, w => (w < 52 ? 0.7 : 0.4), seed * 11, 8)).alarm) alarms++
    expect(alarms).toBeGreaterThanOrEqual(16)
  })
  it('uses one scan per week and waits for enough points', () => {
    const [p, s] = history(5, 0.5, 3)
    const d = sb.driftVsRandom(p, s)
    expect(d.points).toBe(5)
    expect(d.ready).toBe(false)
    expect(d.alarm).toBe(false)
    const hourly = [...p, ...p.map(x => ({ ...x, generatedAt: iso(Date.parse(x.generatedAt) + 3600_000) }))]
    const hourlyShadows = [...s, ...s.map(x => ({ ...x, generatedAt: iso(Date.parse(x.generatedAt) + 3600_000) }))]
    expect(sb.driftVsRandom(hourly, hourlyShadows).points).toBe(5)
  })
  it('compareToShadows carries the drift check', () => {
    const v = sb.compareToShadows(...history(20, 0.5, 4))
    expect(v.drift.points).toBe(20)
  })
})

describe('learning store and labelled datasets', () => {
  it('calibrationReport counts one surface naming one stock daily as one outcome per window', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...ls.buildDecision({ surface: 'advisory', symbol: 'AAPL', action: 'buy', price: 100, at: iso(T0 + i * DAY) }),
      outcome: { at: iso(T0 + (i + 7) * DAY), price: 105, retPct: 5, benchRetPct: 0, horizonDays: 7 },
    }))
    const rep = ls.calibrationReport(rows)
    expect(rep.totalResolved).toBe(7)
    expect(rep.independentResolved).toBe(1)
  })
  it('meta-label rows thin overlapping picks of one stock on their own horizon', () => {
    const recs = [0, 10, 100].map(d => ({ symbol: 'A', generatedAt: iso(T0 + d * DAY), horizonDays: 91, barrier: { label: 'target', window: 91 } }))
    expect(meta.independentLabelled(recs).length).toBe(2)
    expect(meta.rowsFrom(recs).length).toBe(2)
  })
})

describe('Agent Desk findings and operator alerts', () => {
  const desk = require('../lib/agent-desk')
  const ops = require('../lib/ops-alerts')
  it('a flat ranking and a drift alarm become findings', () => {
    const f = desk.brainFindings({
      stats: { ranking: { ready: true, verdict: 'flat', metric: 'alpha', n: 80, horizon: 30, score: { rho: 0.02, lo: -0.2, hi: 0.24 } } },
      vsRandom: { verdict: 'beats-random', drift: { alarm: true, meanLead: 0.1, recentLead: -0.05, alarmAt: '2026-10-01T00:00:00Z', points: 40, horizon: 7 } },
    })
    expect(f.map(x => x.key)).toEqual(expect.arrayContaining(['ranking-flat', 'vs-random-drift']))
  })
  it('a ranking that works raises nothing', () => {
    const f = desk.brainFindings({ stats: { ranking: { ready: true, verdict: 'ranks', n: 80, score: { rho: 0.3, lo: 0.1, hi: 0.5 } } } })
    expect(f.some(x => x.key.startsWith('ranking'))).toBe(false)
  })
  it('the drift alarm is an operator alert keyed by its start date', () => {
    const a = ops.collectAlerts({ brainDrift: { alarm: true, alarmAt: '2026-10-01T00:00:00Z', points: 40, horizon: 7, meanLead: 0.1, recentLead: -0.05 } })
    expect(a[0].key).toBe('brain-drift:2026-10-01')
    expect(ops.collectAlerts({ brainDrift: { alarm: false } })).toEqual([])
  })
})
