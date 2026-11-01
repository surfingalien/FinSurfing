'use strict'
/**
 * lib/quant/calculators.js — closed-form relative-value calculators.
 *
 * These strategies cannot be backtested here — the app has no feed for futures curves, deal terms, CDS
 * spreads, convertible bond prices or option chains — so each one is a calculator over inputs the user
 * supplies (or that another endpoint returns). They answer "what does this trade pay if it works, what is
 * the market implying, and what does it cost to be wrong", and say plainly which inputs they assumed.
 *
 *   carryTrade · basisTrade · rollYield · mergerArb · convertibleArb · merton (credit) · vasicek (rates)
 *   yieldCurve · dispersion · volTermStructure · skewMetrics · skewAwareDelta
 *   avellanedaStoikov (market making) · executionSchedule (VWAP/TWAP) · implementationShortfall
 * Tests: tests/quant-calculators.test.js
 */
const L = require('./linalg')
const O = require('./options')

const need = (cond, msg) => { if (!cond) throw new Error(msg) }

/** Currency carry: earn the rate differential, risk the exchange-rate move. */
function carryTrade({ rateLong, rateShort, fxVol = null, years = 1 }) {
  const carry = rateLong - rateShort, breakevenMove = carry * years
  return { annualCarry: carry, breakevenAdverseMove: breakevenMove, carryToVol: fxVol > 0 ? carry / fxVol : null, warning: 'Carry trades earn small steady gains and give them back in sudden unwinds; size for the crash, not the average.' }
}

/** Cash-and-carry: fair futures = S·e^{(r + storage − yield)·T}; basis = F − S; mispricing = F − fair. */
function basisTrade({ spot, futures, days, rate, yieldOrConvenience = 0, storage = 0, costPerUnit = 0 }) {
  need(spot > 0 && futures > 0 && days > 0, 'spot, futures and days must be positive')
  const T = days / 365, fair = spot * Math.exp((rate + storage - yieldOrConvenience) * T), basis = futures - spot, mis = futures - fair
  return {
    fairFuture: fair, basis, annualisedBasis: (futures / spot - 1) / T, mispricing: mis,
    signal: Math.abs(mis) <= costPerUnit ? 'no edge after costs' : mis > 0 ? 'futures rich: sell futures, buy spot, hold to expiry' : 'futures cheap: buy futures, short spot (if you can borrow it)',
    convergesTo: 0, note: 'The basis converges to zero at expiry; the trade is a bet on financing and borrow costs, not on price direction.',
  }
}

/** Roll yield for a long position: positive in backwardation (near > far), negative in contango. Annualised. */
function rollYield({ near, far, daysBetween }) {
  need(near > 0 && far > 0 && daysBetween > 0, 'prices and days must be positive')
  const y = (near / far - 1) * 365 / daysBetween
  return { rollYield: y, structure: far > near ? 'contango' : far < near ? 'backwardation' : 'flat', note: y < 0 ? 'A long position bleeds this much per year just from rolling' : 'A long position earns this much per year from rolling' }
}

/** Announced-deal arbitrage. Offer value is cash + ratio × acquirer price; breakPrice is where the target trades if the deal dies. */
function mergerArb({ targetPrice, cash = 0, stockRatio = 0, acquirerPrice = 0, daysToClose, breakPrice, probabilityOfClose = null }) {
  const offer = cash + stockRatio * acquirerPrice
  need(targetPrice > 0 && offer > 0 && daysToClose > 0, 'target price, offer value and days to close must be positive')
  const gross = offer - targetPrice, grossPct = gross / targetPrice, annual = Math.pow(1 + grossPct, 365 / daysToClose) - 1
  const out = { offerValue: offer, grossSpread: gross, grossSpreadPct: grossPct, annualisedSpread: annual }
  if (breakPrice != null) {
    need(breakPrice < targetPrice, 'break price must be below the current target price')
    out.impliedProbabilityOfClose = (targetPrice - breakPrice) / (offer - breakPrice)
    out.upsideDownsideRatio = gross / (targetPrice - breakPrice)
    if (probabilityOfClose != null) { const ev = probabilityOfClose * offer + (1 - probabilityOfClose) * breakPrice - targetPrice; out.expectedGain = ev; out.expectedReturnPct = ev / targetPrice; out.verdict = ev > 0 ? 'positive expected value at your probability' : 'negative expected value at your probability' }
  } else out.note = 'Supply a break price to see the probability the market is pricing and the loss if the deal fails.'
  return out
}

/** Convertible bond arbitrage: parity, premiums and the delta hedge. delta = the option's delta per share of conversion. */
function convertibleArb({ bondPrice, stockPrice, conversionRatio, bondFloor, delta }) {
  need(bondPrice > 0 && stockPrice > 0 && conversionRatio > 0, 'bond price, stock price and conversion ratio are required')
  const parity = stockPrice * conversionRatio
  return {
    parity, conversionPremiumPct: bondPrice / parity - 1, investmentPremiumPct: bondFloor > 0 ? bondPrice / bondFloor - 1 : null,
    impliedOptionValue: bondFloor > 0 ? bondPrice - bondFloor : null,
    hedgeSharesToShort: delta != null ? conversionRatio * delta : null,
    note: 'Long the convert, short delta × ratio shares: you are paid for volatility (gamma) and the coupon, and lose if the issuer’s credit deteriorates — hedge that separately.',
  }
}

/**
 * Merton (1974) structural credit model. From equity value E, equity volatility σE, face value of debt D, rate r and
 * horizon T, solve for the asset value V and asset volatility σV, then distance-to-default, default probability and the
 * credit spread the model implies. Capital-structure arbitrage compares that spread with the market's.
 */
function merton({ equityValue, equityVol, debtFace, rate, years = 1, marketSpread = null }) {
  need(equityValue > 0 && equityVol > 0 && debtFace > 0 && years > 0, 'equity value, equity vol, debt and horizon must be positive')
  const E = equityValue, D = debtFace, r = rate, T = years
  let V = E + D, sV = equityVol * E / V
  const eq = (v, s) => { const sq = s * Math.sqrt(T), d1 = (Math.log(v / D) + (r + 0.5 * s * s) * T) / sq; return { d1, e: v * L.normCdf(d1) - D * Math.exp(-r * T) * L.normCdf(d1 - sq) } }
  for (let it = 0; it < 200; it++) {
    let lo = E, hi = E + D * 50
    for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (eq(m, sV).e < E) lo = m; else hi = m }
    V = (lo + hi) / 2
    const nsV = equityVol * E / (L.normCdf(eq(V, sV).d1) * V)
    if (Math.abs(nsV - sV) < 1e-10) { sV = nsV; break }
    sV = 0.5 * sV + 0.5 * nsV
  }
  const sq = sV * Math.sqrt(T), d1 = (Math.log(V / D) + (r + 0.5 * sV * sV) * T) / sq, d2 = d1 - sq
  const debtValue = V - E, yld = -Math.log(debtValue / D) / T, spread = yld - r
  const out = { assetValue: V, assetVol: sV, leverage: D / V, distanceToDefault: d2, defaultProbabilityRiskNeutral: L.normCdf(-d2), impliedSpread: spread }
  if (marketSpread != null) {
    out.marketSpread = marketSpread; out.spreadGap = marketSpread - spread
    out.signal = marketSpread > spread * 1.5 ? 'bonds look cheap vs equity (market spread wide of the model)' : marketSpread < spread * 0.67 ? 'bonds look rich vs equity (market spread tight of the model)' : 'debt and equity price credit consistently'
  }
  out.note = 'Textbook Merton: one maturity, no coupons or covenants. It orders credits sensibly; do not trade its level literally.'
  return out
}

/** Vasicek short-rate model: dr = κ(θ − r)dt + σ dW. Zero-coupon price, yield curve and long-run mean. */
function vasicek({ r0, kappa, theta, sigma, maturities = [0.25, 0.5, 1, 2, 5, 10, 30] }) {
  need(kappa > 0 && sigma >= 0, 'kappa must be positive and sigma non-negative')
  const curve = maturities.map(tau => {
    const B = (1 - Math.exp(-kappa * tau)) / kappa, A = Math.exp((theta - sigma * sigma / (2 * kappa * kappa)) * (B - tau) - sigma * sigma * B * B / (4 * kappa)), P = A * Math.exp(-B * r0)
    return { maturity: tau, price: P, yield: -Math.log(P) / tau }
  })
  return { curve, longRunRate: theta, stationaryVol: sigma / Math.sqrt(2 * kappa), halfLifeYears: Math.log(2) / kappa, shape: curve[curve.length - 1].yield > curve[0].yield ? 'upward sloping' : 'downward sloping / inverted' }
}

/** Curve shape from yields in percent keyed '3m','2y','5y','10y','30y'. Slope, butterfly and inversion flags; z-score when `history` is given. */
function yieldCurve(rates, { history = null } = {}) {
  const g = k => (rates[k] != null ? rates[k] : null)
  const s2s10 = g('10y') != null && g('2y') != null ? g('10y') - g('2y') : null
  const s5s30 = g('30y') != null && g('5y') != null ? g('30y') - g('5y') : null
  const s3m10 = g('10y') != null && g('3m') != null ? g('10y') - g('3m') : null
  const fly = g('2y') != null && g('5y') != null && g('10y') != null ? 2 * g('5y') - g('2y') - g('10y') : null
  const out = { slope2s10s: s2s10, slope5s30s: s5s30, slope3m10y: s3m10, butterfly2s5s10s: fly, inverted: [s2s10, s3m10].some(v => v != null && v < 0) }
  if (history && history.length > 30 && s2s10 != null) { const sd = L.stdev(history); out.slope2s10sZ = sd > 0 ? (s2s10 - L.mean(history)) / sd : null }
  out.read = out.inverted ? 'inverted curve: short rates above long rates (historically a recession signal, with long and variable lags)' : s2s10 != null && s2s10 < 0.25 ? 'flat curve' : 'upward sloping curve'
  return out
}

/** Index vol vs single-stock vols → the correlation the index options imply: ρ = (σI² − Σw²σ²) / ((Σwσ)² − Σw²σ²). */
function dispersion({ indexVol, weights, vols, realizedCorr = null }) {
  need(weights.length === vols.length && weights.length >= 2, 'weights and vols must have the same length (≥ 2)')
  const sw2 = L.sum(weights.map((w, i) => (w * vols[i]) ** 2)), swv = L.sum(weights.map((w, i) => w * vols[i]))
  const implied = (indexVol * indexVol - sw2) / (swv * swv - sw2)
  const out = { impliedCorrelation: implied, bounds: implied < 0 || implied > 1 ? 'outside [0,1]: inputs are inconsistent (check weights sum to 1 and use the same vol basis)' : 'within [0,1]' }
  if (realizedCorr != null) { out.realizedCorrelation = realizedCorr; out.signal = implied > realizedCorr + 0.1 ? 'index vol rich vs components: short index vol, long single-stock vol (classic dispersion)' : implied < realizedCorr - 0.1 ? 'index vol cheap vs components' : 'no clear dispersion edge' }
  return out
}

/** Implied-vol term structure from [{days, iv}]. Slope, shape, and the forward vol between each pair of expiries. */
function volTermStructure(points) {
  const p = [...points].filter(x => x.days > 0 && x.iv > 0).sort((a, b) => a.days - b.days); need(p.length >= 2, 'need at least two expiries')
  const forwards = []
  for (let i = 1; i < p.length; i++) { const T1 = p[i - 1].days / 365, T2 = p[i].days / 365, v = (p[i].iv ** 2 * T2 - p[i - 1].iv ** 2 * T1) / (T2 - T1); forwards.push({ from: p[i - 1].days, to: p[i].days, forwardVol: v > 0 ? Math.sqrt(v) : null }) }
  const slope = p[p.length - 1].iv - p[0].iv
  return { slope, shape: slope > 0.01 ? 'contango (normal: longer-dated vol higher)' : slope < -0.01 ? 'backwardation (stress: near-term vol above long-term)' : 'flat', forwards, calendarIdea: slope < -0.01 ? 'near-term options are expensive vs later ones' : 'near-term options are cheap vs later ones' }
}

/** Smile metrics from [{strike, iv}] at one expiry: ATM vol, 25Δ risk reversal and butterfly (interpolated in delta), and the skew slope. */
function skewMetrics({ S, T, r = 0, strikes }) {
  const q = strikes.filter(x => x.strike > 0 && x.iv > 0).map(x => ({ ...x, delta: O.greeks({ S, K: x.strike, r, sigma: x.iv, T, type: 'call' }).delta })).sort((a, b) => b.delta - a.delta)
  need(q.length >= 5, 'need at least five strikes')
  const at = d => { for (let i = 1; i < q.length; i++) if (q[i].delta <= d && q[i - 1].delta >= d) { const w = (q[i - 1].delta - d) / (q[i - 1].delta - q[i].delta); return q[i - 1].iv * (1 - w) + q[i].iv * w } return null }
  const atm = at(0.5), c25 = at(0.25), p25 = at(0.75)
  const slope = L.ols(q.map(x => [x.strike / S]), q.map(x => x.iv)).beta[1]
  return { atmVol: atm, call25: c25, put25: p25, riskReversal25: c25 != null && p25 != null ? c25 - p25 : null, butterfly25: c25 != null && p25 != null && atm != null ? 0.5 * (c25 + p25) - atm : null, slopePerMoneyness: slope, skew: slope < 0 ? 'downside skew (puts richer than calls)' : 'upside skew (calls richer)' }
}

/** Delta that accounts for the smile moving with spot: Δ_MV ≈ Δ_BS + Vega·∂σ/∂S. regime: 'sticky-strike' (∂σ/∂S=0) or 'sticky-delta' (∂σ/∂S = −(K/S)·∂σ/∂K). */
function skewAwareDelta({ S, K, r = 0, sigma, T, type = 'call', regime = 'sticky-delta', dSigmaDK = 0 }) {
  const g = O.greeks({ S, K, r, sigma, T, type }), dSdS = regime === 'sticky-strike' ? 0 : -(K / S) * dSigmaDK
  return { deltaBS: g.delta, vega: g.vega, dSigmaDS: dSdS, deltaSkewAware: g.delta + g.vega * dSdS, adjustment: g.vega * dSdS, regime }
}

/** Avellaneda–Stoikov market-making quotes. q = inventory (+long), γ risk aversion, σ per-√time vol, k order-arrival decay, tau = time left. */
function avellanedaStoikov({ mid, inventory = 0, gamma = 0.1, sigma, k = 1.5, tau = 1 }) {
  need(mid > 0 && sigma > 0 && gamma > 0 && k > 0 && tau >= 0, 'mid, sigma, gamma, k must be positive')
  const reservation = mid - inventory * gamma * sigma * sigma * tau, spread = gamma * sigma * sigma * tau + (2 / gamma) * Math.log(1 + gamma / k)
  return { reservation, spread, bid: reservation - spread / 2, ask: reservation + spread / 2, skewVsMid: reservation - mid, note: inventory > 0 ? 'long inventory: quotes shift down to encourage selling' : inventory < 0 ? 'short inventory: quotes shift up to encourage buying' : 'flat inventory: quotes centred on the mid' }
}

/** Slice an order over `slices` intervals. TWAP is even; VWAP follows a volume profile (default: U-shaped intraday curve). */
function executionSchedule({ shares, slices = 13, type = 'vwap', profile = null }) {
  need(shares > 0 && slices >= 1, 'shares and slices must be positive')
  let w
  if (type === 'twap') w = new Array(slices).fill(1)
  else if (profile && profile.length === slices) w = profile
  else w = Array.from({ length: slices }, (_, i) => { const x = (i + 0.5) / slices; return 1 + 1.6 * (Math.pow(2 * x - 1, 2)) })   // heavy open and close
  const tot = L.sum(w); let assigned = 0
  const out = w.map((v, i) => { const q = i === slices - 1 ? shares - assigned : Math.round(shares * v / tot); assigned += q; return { slice: i + 1, shares: q, share: q / shares } })
  return { type, slices: out, note: type === 'vwap' ? 'Default profile is a generic U-shape; pass your own volume profile for a real VWAP schedule' : 'Even slices ignore the volume curve and are easy to detect' }
}
/** Implementation shortfall in bps vs the arrival price (positive = cost). */
function implementationShortfall({ side = 'buy', arrival, avgFill }) { need(arrival > 0 && avgFill > 0, 'prices must be positive'); const sgn = side === 'buy' ? 1 : -1; return { bps: sgn * (avgFill - arrival) / arrival * 1e4 } }

module.exports = { carryTrade, basisTrade, rollYield, mergerArb, convertibleArb, merton, vasicek, yieldCurve, dispersion, volTermStructure, skewMetrics, skewAwareDelta, avellanedaStoikov, executionSchedule, implementationShortfall }
