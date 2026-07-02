'use strict'
/**
 * lib/macro-playbook.js
 *
 * Regime playbook — deterministic macro-regime → strategy-tilt mapping.
 *
 * Turns the FRED indicator values already computed by routes/macro.js into
 * explicit, rule-derived tilts ("favor X / avoid Y / strategy bias Z") that
 * get appended to the macroSummary prompt injection. The thresholds mirror
 * the signal thresholds in routes/macro.js:assessRegime so the playbook can
 * never contradict the displayed regime signals. Pure code — the LLM
 * interprets these tilts, it never generates them.
 *
 * Tests: tests/macro-playbook.test.js
 */

const MAX_TILTS = 6

/**
 * @param {Array<{id: string, value: number|null}>} indicators — routes/macro.js FRED rows
 * @returns {{ favor: string[], avoid: string[], strategyBias: string, text: string }}
 *          text is '' when no indicator produced a tilt (e.g. all values null).
 */
function buildRegimePlaybook(indicators) {
  const get = id => indicators?.find(i => i.id === id)?.value ?? null

  const t10y2y = get('T10Y2Y')
  const cpi    = get('CPIAUCSL')
  const ff     = get('FEDFUNDS')
  const vix    = get('VIXCLS')
  const hy     = get('BAMLH0A0HYM2')
  const unrate = get('UNRATE')

  const favor = new Set()
  const avoid = new Set()

  // Yield curve — thresholds match assessRegime
  if (t10y2y != null) {
    if (t10y2y < -0.5) {
      favor.add('defensive sectors (staples, healthcare, utilities)')
      favor.add('quality large caps with fortress balance sheets')
      avoid.add('rate-sensitive cyclicals')
    } else if (t10y2y > 1.5) {
      favor.add('cyclicals & financials (steep curve aids lending margins)')
      favor.add('small caps')
    }
  }

  // Inflation
  if (cpi != null) {
    if (cpi > 5) {
      favor.add('commodities/energy & pricing-power names')
      avoid.add('unprofitable long-duration growth')
    } else if (cpi > 3) {
      favor.add('value with near-term cash flows over distant-earnings growth')
    } else if (cpi < 1.5) {
      favor.add('duration (bonds, dividend growers)')
      avoid.add('commodity-heavy cyclicals')
    }
  }

  // Rate level
  if (ff != null) {
    if (ff > 4.5) {
      favor.add('strong balance sheets (low refinancing need)')
      avoid.add('highly-leveraged names facing refinancing')
    } else if (ff < 2) {
      favor.add('long-duration growth (cheap capital)')
    }
  }

  // Volatility
  if (vix != null) {
    if (vix > 30) {
      favor.add('staged/scaled entries at support rather than full-size buys')
      avoid.add('breakout chasing & leveraged ETFs')
    } else if (vix < 15) {
      favor.add('trend-continuation setups')
    }
  }

  // Credit
  if (hy != null) {
    if (hy > 6) {
      favor.add('investment-grade quality')
      avoid.add('high-yield credit & weak balance sheets')
    } else if (hy < 3) {
      favor.add('risk assets broadly (credit healthy)')
    }
  }

  // Labor / consumer
  if (unrate != null) {
    if (unrate > 5.5) avoid.add('consumer discretionary (spending at risk)')
    else if (unrate < 4) favor.add('consumer discretionary (tight labor, resilient spending)')
  }

  // Strategy-type bias — connects to the Strategy Lab / backtest strategy families
  let strategyBias
  if (vix == null)      strategyBias = 'balanced (volatility unknown)'
  else if (vix > 25)    strategyBias = 'mean-reversion over trend-following (elevated vol: fade extremes, use wider stops)'
  else if (vix < 15)    strategyBias = 'trend-following over mean-reversion (low vol: ride momentum, tighter trailing stops)'
  else                  strategyBias = 'balanced (mid-range vol: be selective in both trend and reversion setups)'

  const favorList = [...favor].slice(0, MAX_TILTS)
  const avoidList = [...avoid].slice(0, MAX_TILTS)

  if (!favorList.length && !avoidList.length && vix == null) {
    return { favor: [], avoid: [], strategyBias, text: '' }
  }

  const lines = ['REGIME PLAYBOOK (rule-derived from the indicators above — when a pick follows a tilt, cite it as evidence):']
  if (favorList.length) lines.push(`Favor: ${favorList.join('; ')}`)
  if (avoidList.length) lines.push(`Avoid: ${avoidList.join('; ')}`)
  lines.push(`Strategy bias: ${strategyBias}`)

  return { favor: favorList, avoid: avoidList, strategyBias, text: '\n' + lines.join('\n') }
}

module.exports = { buildRegimePlaybook }
