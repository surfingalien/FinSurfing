'use strict'
/**
 * lib/earnings-quality.js — are a company's reported earnings backed by cash?
 *
 * A forensic read of the company's own SEC filings (lib/sec-facts.js, keyless,
 * point in time: only figures FILED by `asOf`, first-filed values, so a
 * restatement never leaks backwards):
 *
 *   cash conversion     operating cash flow ÷ net income, trailing four quarters,
 *                       and the same a year earlier (only when net income > 0)
 *   FCF conversion      (operating cash flow − capex) ÷ net income
 *   accruals            (net income − operating cash flow) ÷ total assets (Sloan)
 *   DSO / DIO / DPO     days of sales in receivables, of cost of sales in
 *                       inventory, of cost of sales in payables — now and a
 *                       year earlier
 *   receivables gap     receivables growth − revenue growth (points)
 *   inventory gap       inventory growth − cost-of-sales growth (points)
 *   stock pay share     share-based compensation ÷ operating cash flow (it is a
 *                       non-cash expense added back, so it flatters cash flow)
 *
 * FLAGS are descriptive, with their thresholds stated below: things an analyst
 * would read before trusting the earnings. They are evidence, never a verdict;
 * whether any of them predicts returns is decided by the weekly factor-mining
 * run, which tests `cash_conversion` and `receivables_discipline` as ordinary
 * candidates (holdout + deflated Sharpe).
 *
 * Pure. Tests: tests/earnings-quality.test.js
 */

const DAY = 86_400_000
// A trailing year that ended this long before asOf is stale — e.g. banks stopped
// tagging the revenue concepts years ago, so their "latest" year is from 2014.
const MAX_AGE_DAYS = 450

const FLAG_RULES = {
  CASH_CONVERSION_LOW: 0.8,     // operating cash flow below 80% of net income
  CASH_CONVERSION_DROP: 0.3,    // and/or down this much on a year earlier
  GAP_POINTS: 10,               // receivables / inventory growing 10+ points faster than sales / cost of sales
  ACCRUALS_PCT: 5,              // (NI − OCF) above 5% of total assets
  SBC_SHARE_PCT: 25,            // stock pay above 25% of operating cash flow
}

const known = (series, asOf, endBy = null) => (series || []).filter(q => q.filed <= asOf && (!endBy || q.end <= endBy))
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

/** Sum of the last four consecutive quarters filed by asOf (ending ≤ endBy). */
function ttm(series, asOf, endBy = null) {
  const qs = known(series, asOf, endBy)
  if (qs.length < 4) return null
  const last4 = qs.slice(-4)
  if (days(last4[0].start || last4[0].end, last4[3].end) > 380) return null
  return { val: last4.reduce((a, q) => a + q.val, 0), end: last4[3].end }
}
const balance = (series, asOf, endBy = null) => known(series, asOf, endBy).at(-1) ?? null

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2))
const r1 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(1))
const growth = (now, then) => (now != null && then != null && then > 0 ? ((now / then) - 1) * 100 : null)
const ratio = (a, b) => (a != null && b != null && b > 0 ? a / b : null)

/**
 * Earnings-quality read of a company on `asOf` (YYYY-MM-DD) from its compact
 * SEC series. null when there is no trailing year of revenue or earnings.
 */
function qualityAt(compact, asOf) {
  const s = compact?.series || {}
  const rev = ttm(s.revenue, asOf), ni = ttm(s.netIncome, asOf)
  if (!rev && !ni) return null
  const periodEnd = rev?.end ?? ni.end
  if (days(periodEnd, asOf) > MAX_AGE_DAYS) return null
  const yearEarlier = new Date(Date.parse(periodEnd) - 360 * DAY).toISOString().slice(0, 10)
  const ocf = ttm(s.ocf, asOf), capex = ttm(s.capex, asOf), cogs = ttm(s.costOfRevenue, asOf), sbc = ttm(s.sbc, asOf)
  const niP = ttm(s.netIncome, asOf, yearEarlier), ocfP = ttm(s.ocf, asOf, yearEarlier)
  const revP = ttm(s.revenue, asOf, yearEarlier), cogsP = ttm(s.costOfRevenue, asOf, yearEarlier)
  const rec = balance(s.receivables, asOf), recP = balance(s.receivables, asOf, yearEarlier)
  const inv = balance(s.inventory, asOf), invP = balance(s.inventory, asOf, yearEarlier)
  const pay = balance(s.payables, asOf), assets = balance(s.assets, asOf)

  const conv = (o, n) => (o && n && n.val > 0 ? o.val / n.val : null)
  const out = {
    asOf, periodEnd,
    lastFiled: [s.revenue, s.netIncome, s.ocf].map(x => known(x, asOf).at(-1)?.filed).filter(Boolean).sort().at(-1) ?? null,
    netIncomeTtm: ni?.val ?? null,
    ocfTtm: ocf?.val ?? null,
    cashConversion: r2(conv(ocf, ni)),
    cashConversionPrior: r2(conv(ocfP, niP)),
    fcfConversion: r2(ocf && capex && ni?.val > 0 ? (ocf.val - Math.abs(capex.val)) / ni.val : null),
    accruals: r2(ni && ocf && assets?.val > 0 ? ((ni.val - ocf.val) / assets.val) * 100 : null),
    dso: r1(rec && rev ? ratio(rec.val, rev.val) * 365 : null),
    dsoPrior: r1(recP && revP ? ratio(recP.val, revP.val) * 365 : null),
    dio: r1(inv && cogs ? ratio(inv.val, cogs.val) * 365 : null),
    dioPrior: r1(invP && cogsP ? ratio(invP.val, cogsP.val) * 365 : null),
    dpo: r1(pay && cogs ? ratio(pay.val, cogs.val) * 365 : null),
    receivablesGap: r1(rec && recP && rev && revP ? growth(rec.val, recP.val) - growth(rev.val, revP.val) : null),
    inventoryGap: r1(inv && invP && cogs && cogsP ? growth(inv.val, invP.val) - growth(cogs.val, cogsP.val) : null),
    sbcShareOfOcf: r1(sbc && ocf?.val > 0 ? (sbc.val / ocf.val) * 100 : null),
    lossMaking: ni ? ni.val <= 0 : null,
  }
  out.flags = flagsOf(out)
  out.checked = ['cashConversion', 'accruals', 'receivablesGap', 'inventoryGap', 'sbcShareOfOcf'].filter(k => out[k] != null).length
  return out
}

/** The red flags a quality read raises, each with the figure behind it. Pure. */
function flagsOf(q) {
  const F = FLAG_RULES, flags = []
  if (q.cashConversion != null && q.cashConversion < F.CASH_CONVERSION_LOW) {
    flags.push({ key: 'earnings-ahead-of-cash', text: `operating cash flow is only ${q.cashConversion}× net income (below ${F.CASH_CONVERSION_LOW}×)` })
  }
  if (q.cashConversion != null && q.cashConversionPrior != null && q.cashConversionPrior - q.cashConversion > F.CASH_CONVERSION_DROP) {
    flags.push({ key: 'cash-conversion-falling', text: `cash conversion fell from ${q.cashConversionPrior}× to ${q.cashConversion}× in a year` })
  }
  if (q.receivablesGap != null && q.receivablesGap > F.GAP_POINTS) {
    flags.push({ key: 'receivables-outpace-sales', text: `receivables grew ${q.receivablesGap} points faster than revenue${q.dso != null && q.dsoPrior != null ? ` (DSO ${q.dsoPrior} → ${q.dso} days)` : ''}` })
  }
  if (q.inventoryGap != null && q.inventoryGap > F.GAP_POINTS) {
    flags.push({ key: 'inventory-building', text: `inventory grew ${q.inventoryGap} points faster than cost of sales${q.dio != null && q.dioPrior != null ? ` (DIO ${q.dioPrior} → ${q.dio} days)` : ''}` })
  }
  if (q.accruals != null && q.accruals > F.ACCRUALS_PCT) {
    flags.push({ key: 'high-accruals', text: `accruals are ${q.accruals}% of total assets (earnings well above operating cash flow)` })
  }
  if (q.sbcShareOfOcf != null && q.sbcShareOfOcf > F.SBC_SHARE_PCT) {
    flags.push({ key: 'stock-pay-heavy', text: `stock-based pay is ${q.sbcShareOfOcf}% of operating cash flow (non-cash, added back)` })
  }
  return flags
}

/** One evidence paragraph for the Research Desk, or null. Pure. */
function describe(q, symbol = 'The company') {
  if (!q || !q.checked) return null
  const parts = [
    q.cashConversion != null && `operating cash flow ${q.cashConversion}× net income${q.cashConversionPrior != null ? ` (${q.cashConversionPrior}× a year earlier)` : ''}`,
    q.lossMaking && 'loss-making over the last four quarters, so cash conversion is not defined',
    q.fcfConversion != null && `free cash flow ${q.fcfConversion}× net income`,
    q.accruals != null && `accruals ${q.accruals}% of assets`,
    q.dso != null && `DSO ${q.dsoPrior != null ? `${q.dsoPrior} → ` : ''}${q.dso} days`,
    q.dio != null && `DIO ${q.dioPrior != null ? `${q.dioPrior} → ` : ''}${q.dio} days`,
    q.dpo != null && `DPO ${q.dpo} days`,
    q.sbcShareOfOcf != null && `stock pay ${q.sbcShareOfOcf}% of operating cash flow`,
  ].filter(Boolean)
  const flagText = q.flags.length
    ? `Flags: ${q.flags.map(f => f.text).join('; ')}.`
    : `No red flags on the ${q.checked} checks that could be computed.`
  return `${symbol}'s earnings quality from SEC filings (four quarters to ${q.periodEnd}, filed by ${q.lastFiled}): ${parts.join('; ')}. ${flagText} Flags are things to read, not a verdict; whether they predict returns is tested weekly by factor mining.`
}

module.exports = { MAX_AGE_DAYS, FLAG_RULES, qualityAt, flagsOf, describe }
