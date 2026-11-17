'use strict'
/**
 * lib/pine-export.js — a trade plan's levels as a small TradingView Pine Script.
 *
 * Paste the script into TradingView's Pine Editor and the plan's entry range,
 * stop and targets appear as lines on your own chart. It draws lines and
 * nothing else: no alerts, no orders, no strategy.
 *
 * Pure and shared with the browser (tools/vite-shared-cjs.mjs), so it requires
 * nothing. Everything that reaches the script is sanitised here: the symbol is
 * reduced to ticker characters and every level must be a finite positive
 * number, so no text from a model or a user can end up as Pine code.
 *
 * Tests: tests/pine-export.test.js
 */

const COLORS = { entry: 'color.blue', stop: 'color.red', target: 'color.green', price: 'color.gray' }

const ticker = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)
const num = v => (v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toPrecision(6))
/** A Pine identifier from a label: letters and digits only, never starting with a digit. */
const ident = (label, i) => {
  const core = String(label || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
    .map((w, k) => (k === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('')
  return /^[a-z][A-Za-z0-9]*$/.test(core) ? core : `level${i + 1}`
}
/** Text inside a Pine string literal: no quotes, backslashes or line breaks. */
const text = s => String(s || '').replace(/[^A-Za-z0-9 ,:%\-]/g, '').slice(0, 60)

/**
 * @param {object}   o
 * @param {string}   o.symbol
 * @param {object[]} o.levels   [{price, label, role}] — lib/chart-events.js:planLevels(plan)
 * @param {string}  [o.basis]   'thesis' | anything else = reference levels
 * @param {string}  [o.asOf]    YYYY-MM-DD the plan was made
 * @returns {string|null}  the script, or null when there is nothing valid to draw
 */
function planToPine({ symbol, levels = [], basis = null, asOf = null } = {}) {
  const sym = ticker(symbol)
  const ok = (levels || []).filter(l => l && Number.isFinite(l.price) && l.price > 0)
  if (!sym || !ok.length) return null
  const used = new Set()
  const rows = ok.map((l, i) => {
    let id = ident(l.label, i)
    while (used.has(id)) id += 'x'
    used.add(id)
    return { id, price: num(l.price), label: text(l.label) || `Level ${i + 1}`, color: COLORS[l.role] || COLORS.price }
  })
  const kind = basis === 'thesis' ? 'thesis plan' : 'reference levels'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asOf || '') ? asOf : null
  return [
    '//@version=6',
    `// ${sym} ${kind} from FinSurfing${date ? `, made ${date}` : ''}.`,
    '// Lines only: this script places no orders and sets no alerts.',
    basis === 'thesis' ? '// The levels are the thesis plan\'s own numbers.' : '// Reference levels from price action alone. Not a buy signal.',
    `indicator("FinSurfing ${kind} ${sym}", overlay = true)`,
    '',
    ...rows.map(r => `${r.id} = ${r.price}`),
    '',
    ...rows.map(r => `hline(${r.id}, "${r.label}", color = ${r.color}, linestyle = hline.style_dashed)`),
    '',
    '// These prices only mean something on the chart they were made for.',
    `if barstate.islast and syminfo.ticker != "${sym}"`,
    `    label.new(bar_index, high, "These levels were made for ${sym}", color = color.orange, textcolor = color.white)`,
    '',
  ].join('\n')
}

module.exports = { planToPine }
