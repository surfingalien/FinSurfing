'use strict'
/**
 * lib/factor-regression.js — what a stock's returns are made of: Fama–French
 * five factors plus momentum, with Newey–West standard errors.
 *
 *   r_t − RF_t = α + β_mkt (Mkt−RF) + β_smb SMB + β_hml HML + β_rmw RMW
 *                  + β_cma CMA + β_mom MOM + ε_t        (daily, percent)
 *
 * Factors are Ken French's official daily files (the Data Library, keyless;
 * CRSP-based, published monthly, so the window ends at the last factor date —
 * about a month behind). Daily returns overlap in their errors
 * (autocorrelation, volatility clustering), so ordinary OLS standard errors
 * overstate certainty; Newey–West (Bartlett kernel, lag ⌊4(n/100)^{2/9}⌋)
 * corrects them. α is reported per year (×252) with its NW t — "is there
 * return left over after the factors?" — and a |t| below 2 says plainly that
 * it cannot be told from zero.
 *
 * parseFrenchCsv / regress / neweyWest / describe are pure; fetchFactors does
 * the I/O (24h in-memory cache). Tests: tests/factor-regression.test.js
 */

const L = require('./quant/linalg')

const FF5_URL = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_5_Factors_2x3_daily_CSV.zip'
const MOM_URL = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Momentum_Factor_daily_CSV.zip'
const FACTORS = ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA', 'Mom']
const LABELS = { 'Mkt-RF': 'market', SMB: 'size (small minus big)', HML: 'value (high minus low book/price)', RMW: 'profitability (robust minus weak)', CMA: 'investment (conservative minus aggressive)', Mom: 'momentum' }
const CACHE_MS = 24 * 3600_000
const MIN_DAYS = 120

/** Daily rows of a Ken French CSV: Map 'YYYY-MM-DD' → {column: value (percent)}. Only the first table. Pure. */
function parseFrenchCsv(text) {
  const out = new Map()
  let cols = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!cols) { if (/^,/.test(line)) cols = line.split(',').slice(1).map(s => s.trim()); continue }
    const m = line.match(/^(\d{4})(\d{2})(\d{2})\s*,(.*)$/)
    if (!m) { if (out.size) break; continue }   // the daily table ended
    const vals = m[4].split(',').map(v => Number(v.trim()))
    const row = {}
    cols.forEach((c, i) => { row[c] = vals[i] })
    out.set(`${m[1]}-${m[2]}-${m[3]}`, row)
  }
  return out
}

/** Newey–West HAC covariance of OLS coefficients (X includes the intercept column). Pure. */
function neweyWest(X, resid, lag) {
  const n = X.length, p = X[0].length
  const S = Array.from({ length: p }, () => new Array(p).fill(0))
  const add = (i, j, w) => {
    const e = resid[i] * resid[j] * w
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) S[a][b] += e * (X[i][a] * X[j][b] + (i === j ? 0 : X[j][a] * X[i][b]))
  }
  for (let t = 0; t < n; t++) add(t, t, 1)
  for (let l = 1; l <= lag; l++) {
    const w = 1 - l / (lag + 1)
    for (let t = l; t < n; t++) add(t, t - l, w)
  }
  const inv = L.inverse(L.matMul(L.transpose(X), X))
  return L.matMul(L.matMul(inv, S), inv)
}

/**
 * Regress a stock's daily excess returns on the factors over the last `years`
 * of overlapping days. bars: [{t (ms), c}]. Pure.
 */
function regress(bars, factors, { years = 3 } = {}) {
  if (!factors?.size) throw new Error('no factor data')
  const pts = (bars || []).filter(b => b?.c > 0).map(b => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }))
  const last = [...factors.keys()].sort().at(-1)
  const from = new Date(Date.parse(last) - years * 365.25 * 86400e3).toISOString().slice(0, 10)
  const ys = [], X = [], dates = []
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].d
    if (d < from || d > last) continue
    const f = factors.get(d)
    if (!f || FACTORS.some(k => !Number.isFinite(f[k])) || !Number.isFinite(f.RF)) continue
    ys.push(((pts[i].c / pts[i - 1].c) - 1) * 100 - f.RF)
    X.push(FACTORS.map(k => f[k]))
    dates.push(d)
  }
  if (ys.length < MIN_DAYS) throw new Error(`only ${ys.length} days overlap the factor data (need ${MIN_DAYS})`)
  const fit = L.ols(X, ys)
  const n = ys.length, lag = Math.floor(4 * (n / 100) ** (2 / 9))
  const Xd = X.map(r => [1, ...r])
  const V = neweyWest(Xd, fit.resid, lag)
  const se = V.map((r, i) => Math.sqrt(Math.max(0, r[i])))
  const t = fit.beta.map((b, i) => (se[i] > 0 ? b / se[i] : null))
  const r2 = v => +v.toFixed(2)
  return {
    n, lag, from: dates[0], to: dates.at(-1), factorDataThrough: last,
    alphaDailyPct: +fit.beta[0].toFixed(4),
    alphaAnnualPct: r2(fit.beta[0] * 252),
    alphaT: t[0] == null ? null : r2(t[0]),
    alphaOlsT: Number.isFinite(fit.tstat[0]) ? r2(fit.tstat[0]) : null,
    betas: FACTORS.map((k, i) => ({ factor: k, label: LABELS[k], beta: +fit.beta[i + 1].toFixed(3), t: t[i + 1] == null ? null : r2(t[i + 1]) })),
    r2: +fit.r2.toFixed(3),
    residualVolAnnualPct: r2(Math.sqrt(fit.sigma2) * Math.sqrt(252)),
  }
}

/** One evidence sentence. Pure. */
function describe(res, symbol = 'The stock') {
  if (!res) return null
  const sig = res.betas.filter(b => b.factor !== 'Mkt-RF' && b.t != null && Math.abs(b.t) >= 2)
  const mkt = res.betas.find(b => b.factor === 'Mkt-RF')
  const tilt = sig.length ? sig.map(b => `${b.beta > 0 ? '+' : ''}${b.beta} ${b.label} (t ${b.t})`).join(', ') : 'no other factor tilt significant at |t| ≥ 2'
  const alpha = res.alphaT != null && Math.abs(res.alphaT) >= 2
    ? `alpha ${res.alphaAnnualPct > 0 ? '+' : ''}${res.alphaAnnualPct}% a year after the factors (Newey–West t ${res.alphaT})`
    : `alpha ${res.alphaAnnualPct > 0 ? '+' : ''}${res.alphaAnnualPct}% a year, indistinguishable from zero (Newey–West t ${res.alphaT ?? '—'})`
  return `${symbol} against the Fama–French five factors + momentum (daily, ${res.from} to ${res.to}, ${res.n} days; factor data runs to ${res.factorDataThrough}): market beta ${mkt.beta} (t ${mkt.t}); ${tilt}; ${alpha}. The factors explain ${Math.round(res.r2 * 100)}% of its daily moves; the rest is ${res.residualVolAnnualPct}% a year of stock-specific volatility.`
}

let _cache = null
/** Fetch and merge the FF5 and momentum daily files (24h cache). */
async function fetchFactors({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (_cache && now - _cache.t < CACHE_MS) return _cache.factors
  const { readZip } = require('./zip-read')
  const get = async url => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'FinSurfing/2.0 (factor data)' }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`Ken French data library answered HTTP ${r.status}`)
    const files = readZip(Buffer.from(await r.arrayBuffer()), n => /\.csv$/i.test(n))
    const text = Object.values(files)[0]
    if (!text) throw new Error('no CSV in the factor archive')
    return parseFrenchCsv(text.toString('latin1'))
  }
  const [ff5, mom] = await Promise.all([get(FF5_URL), get(MOM_URL)])
  const factors = new Map()
  for (const [d, row] of ff5) {
    const m = mom.get(d)
    const momVal = m ? (m.Mom ?? Object.values(m)[0]) : undefined
    if (Number.isFinite(momVal)) factors.set(d, { ...row, Mom: momVal })
  }
  _cache = { t: now, factors }
  return factors
}

function _resetForTests() { _cache = null }

module.exports = { FACTORS, LABELS, MIN_DAYS, parseFrenchCsv, neweyWest, regress, describe, fetchFactors, _resetForTests }
