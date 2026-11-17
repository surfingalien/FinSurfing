const { planToPine } = require('../lib/pine-export')
const { planLevels } = require('../lib/chart-events')

const plan = { entry: { low: 344.73, high: 352.78 }, stop: { price: 321.31 }, booking: [{ label: 'T1 — book partial profit', price: 389.93 }, { label: 'T2 — target', price: 431.1 }] }

test('a plan becomes one line per level, on a version-6 overlay indicator', () => {
  const s = planToPine({ symbol: 'aapl', levels: planLevels(plan), basis: 'thesis', asOf: '2026-11-16' })
  expect(s.startsWith('//@version=6\n')).toBe(true)
  expect(s).toContain('indicator("FinSurfing thesis plan AAPL", overlay = true)')
  expect(s).toContain('entryHigh = 352.78')
  expect(s).toContain('stop = 321.31')
  expect(s).toContain('hline(t1, "T1", color = color.green, linestyle = hline.style_dashed)')
  expect(s).toContain('hline(stop, "Stop", color = color.red')
  expect(s.match(/^hline\(/gm)).toHaveLength(5)
  expect(s).toContain('syminfo.ticker != "AAPL"')
  expect(s).toContain('made 2026-11-16')
})

test('reference levels are labelled as not a buy signal; it never contains an order or an alert', () => {
  const s = planToPine({ symbol: 'NVDA', levels: planLevels(plan) })
  expect(s).toContain('Not a buy signal')
  expect(s).not.toMatch(/strategy\.|alert\(|alertcondition/)
})

test('nothing from outside can become Pine code', () => {
  const s = planToPine({
    symbol: 'AAPL")\nstrategy.entry("x', asOf: '2026-11-16"\nfoo()',
    levels: [{ price: 10, label: 'T1")\nstrategy.entry("x', role: 'target' }, { price: 11, label: '9 lives', role: 'nope' }, { price: 12, label: 'T2', role: 'entry' }, { price: 13, label: 'T2', role: 'entry' }],
  })
  expect(s).not.toMatch(/strategy\.entry|foo\(\)/)            // the dot, quote and brackets are stripped: never a call
  // Every line is one this file writes: a comment, the indicator, an assignment to a plain name, an hline, the warning.
  for (const line of s.split('\n').filter(Boolean)) {
    expect(line).toMatch(/^(\/\/.*|indicator\("[A-Za-z0-9 .\-]+", overlay = true\)|[a-z][A-Za-z0-9]* = [0-9.]+|hline\([a-z][A-Za-z0-9]*, "[A-Za-z0-9 ,:%\-]+", color = color\.[a-z]+, linestyle = hline\.style_dashed\)|if barstate\.islast and syminfo\.ticker != "[A-Z0-9.\-]+"| {4}label\.new\(bar_index, high, "These levels were made for [A-Z0-9.\-]+", color = color\.orange, textcolor = color\.white\))$/)
  }
  expect(s).toContain('level2 = 11.00')                         // an identifier may not start with a digit
  expect(s).toMatch(/^t2 = 12\.00$/m)
  expect(s).toMatch(/^t2x = 13\.00$/m)                          // duplicate names are made distinct
  expect(s).not.toContain(', made ')
})

test('invalid levels are left out; nothing valid means no script', () => {
  expect(planToPine({ symbol: 'AAPL', levels: [{ price: NaN, label: 'x' }, { price: 0, label: 'y' }, { price: -1, label: 'z' }] })).toBeNull()
  expect(planToPine({ symbol: '', levels: planLevels(plan) })).toBeNull()
  expect(planToPine({ symbol: '<>', levels: planLevels(plan) })).toBeNull()
  expect(planToPine()).toBeNull()
  expect(planToPine({ symbol: 'BTC-USD', levels: [{ price: 0.000123456, label: 'Stop', role: 'stop' }] })).toContain('stop = 0.000123456')
})
