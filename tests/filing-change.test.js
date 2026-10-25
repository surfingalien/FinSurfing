'use strict'
// Lazy Prices: how much of a 10-K/10-Q is carried over, measured point-in-time.

const fs = require('fs')
const fc = require('../lib/filing-change')
const fm = require('../lib/factor-mining')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const VOCAB = 'risk revenue customers supply demand operations market growth margin competition regulation capital liquidity debt credit interest product service segment region employee technology security cyber climate litigation tax acquisition dividend share repurchase guidance outlook inventory cost pricing'.split(' ')
const prose = (n, seed) => { const r = rng(seed); return Array.from({ length: n }, () => VOCAB[Math.floor(r() * VOCAB.length)]).join(' ') }

test('numbers and symbols are not words; a short text is not judged', () => {
  expect(fc.words('Revenue rose 12.5% to $3,400 million in Q3 2026.')).toEqual(['revenue', 'rose', 'to', 'million', 'in'])
  expect(fc.signature('too short')).toBeNull()
})

test('the same text is identical whatever its figures; a light edit stays high; a rewrite is low', () => {
  const base = prose(3000, 1)
  const sig = fc.signature(base)
  expect(sig).toHaveLength(fc.HASHES)
  expect(fc.signature(base)).toEqual(sig)                                   // deterministic
  const refigured = base.replace(/revenue/g, 'revenue 1,234').replace(/margin/g, 'margin 9%')
  expect(fc.similarity(sig, fc.signature(refigured))).toBe(1)               // figures changed, wording not
  const w = base.split(' '), edited = [...w.slice(0, 2700), ...prose(300, 2).split(' ')].join(' ')
  expect(fc.similarity(sig, fc.signature(edited))).toBeGreaterThan(0.75)
  expect(fc.similarity(sig, fc.signature(prose(3000, 3)))).toBeLessThan(0.1)
  expect(fc.similarity(sig, null)).toBeNull()
})

const recent = rows => ({
  form: rows.map(r => r[0]), filingDate: rows.map(r => r[1]), reportDate: rows.map(r => r[2]),
  accessionNumber: rows.map((r, i) => r[3] || `acc-${i}`), primaryDocument: rows.map(() => 'doc.htm'),
})

test('each filing is compared with the same form a year earlier, never the previous quarter', () => {
  const list = fc.listFilings(recent([
    ['10-Q', '2026-08-01', '2026-06-30', 'q2-26'], ['10-Q', '2026-05-01', '2026-03-31', 'q1-26'],
    ['10-K', '2026-02-20', '2025-12-31', 'k-25'], ['8-K', '2026-02-01', '2026-02-01', 'x'],
    ['10-Q', '2025-08-01', '2025-06-30', 'q2-25'], ['10-K', '2025-02-20', '2024-12-31', 'k-24'],
  ]))
  expect(list.map(f => f.accession)).toEqual(['k-24', 'q2-25', 'k-25', 'q1-26', 'q2-26'])   // oldest first, no 8-K
  for (const f of list) f.sig = fc.signature(prose(1000, f.accession.length))
  expect(fc.yearAgo(list.find(f => f.accession === 'q2-26'), list).accession).toBe('q2-25')
  expect(fc.yearAgo(list.find(f => f.accession === 'q1-26'), list)).toBeNull()               // no Q1 2025 on file
  expect(fc.yearAgo(list.find(f => f.accession === 'k-25'), list).accession).toBe('k-24')
  fc.scoreAll(list)
  expect(list.find(f => f.accession === 'q2-26')).toMatchObject({ vs: 'q2-25' })
  expect(list.find(f => f.accession === 'q1-26').sim).toBeUndefined()
})

test('the factor reads only a similarity FILED before the day, and drops one over ~13 months old', () => {
  const sims = [{ filed: '2025-03-01', sim: 0.9 }, { filed: '2025-06-01', sim: 0.4 }]
  expect(fc.simAsOf(sims, '2025-06-01')).toBe(0.9)          // filed that day: not yet known
  expect(fc.simAsOf(sims, '2025-06-02')).toBe(0.4)
  expect(fc.simAsOf(sims, '2025-02-01')).toBeNull()
  expect(fc.simAsOf(sims, '2026-09-01')).toBeNull()         // stale
  const p = { days: ['2025-06-02'], filings: sims }
  expect(fm.FACTORS.filing_sim.fn(p, 0)).toBe(0.4)
  expect(fm.FACTORS.filing_sim.fn({ days: ['2025-06-02'] }, 0)).toBeNull()
})

describe('refresh: list, sign each document once within a time budget, score', () => {
  const docs = {}
  const fetchImpl = async url => {
    const json = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.endsWith('company_tickers.json')) return json({ 0: { ticker: 'AAA', cik_str: 1 } })
    if (url.includes('/submissions/')) return json({ filings: { recent: recent([
      ['10-K', '2025-02-20', '2024-12-31', 'k24'], ['10-K', '2026-02-20', '2025-12-31', 'k25'],
    ]) } })
    const acc = url.match(/\/(k2\d)\//)[1]
    docs[acc] = (docs[acc] || 0) + 1
    const text = acc === 'k24' ? prose(3000, 7) : prose(3000, 7).split(' ').slice(0, 2400).join(' ') + ' ' + prose(600, 8)
    return { ok: true, status: 200, text: async () => `<html><body><p>${text}</p></body></html>` }
  }
  afterAll(() => { try { fs.unlinkSync(fc.STORE_FILE) } catch {} })

  test('a spent budget signs nothing and says what is pending; the next run finishes and scores', async () => {
    const now = new Date(Date.UTC(2026, 9, 25))
    const first = await fc.refresh({ universe: ['AAA'], fetchImpl, budgetMs: -1, now, pauseMs: 0 })
    expect(first).toMatchObject({ signed: 0, pending: 2 })
    const second = await fc.refresh({ universe: ['AAA'], fetchImpl, now, pauseMs: 0 })
    expect(second).toMatchObject({ signed: 2, pending: 0 })
    const k25 = second.store.symbols.AAA.filings.find(f => f.accession === 'k25')
    expect(k25.vs).toBe('k24')
    expect(k25.sim).toBeGreaterThan(0.5)
    expect(k25.sim).toBeLessThan(1)
    await fc.refresh({ universe: ['AAA'], fetchImpl, now, pauseMs: 0 })
    expect(docs).toEqual({ k24: 1, k25: 1 })                 // never downloaded twice
    expect(fc.simsBySymbol()).toEqual({ AAA: [{ filed: '2026-02-20', form: '10-K', sim: k25.sim }] })
    expect(fc.describeFor('AAA')).toMatch(/the 10-K filed 2026-02-20 repeats about \d+% of the 10-K a year earlier\. Low = /)   // no percentile with 1 company
    expect(fc.describeFor('ZZZ')).toBeNull()
  })
})

test('mined like any other factor: a planted "non-changers outperform" effect is found', () => {
  // 40 stocks, quarterly filings with a random similarity; a stock drifts up while its last filing was a near-copy.
  const r = rng(5), t0 = Date.UTC(2021, 0, 4), day = i => new Date(t0 + i * 86400000).toISOString().slice(0, 10)
  const bars = {}, filings = {}
  for (let k = 0; k < 40; k++) {
    const sims = []
    for (let q = 0; q * 63 < 1260; q++) sims.push({ filed: day(q * 63 + 30), sim: +(0.3 + 0.7 * r()).toFixed(3) })
    filings[`S${k}`] = sims
    let c = 50 + k
    bars[`S${k}`] = Array.from({ length: 1260 }, (_, i) => {
      const s = fc.simAsOf(sims, day(i))
      c *= 1 + (s == null ? 0 : (s - 0.65) * 0.004) + 0.012 * (r() - 0.5)
      return { t: t0 + i * 86400000, c, h: c * 1.01, l: c * 0.99, v: 1e6 }
    })
  }
  const lib = fm.mineFactors(bars, { filings, diagnostics: false })
  const f = lib.factors.find(x => x.name === 'filing_sim')
  expect(f.direction).toBe('as-is')
  expect(f.holdout.meanIc).toBeGreaterThan(0.1)
  expect(f.verdict).toBe('admitted')
  // And a stock's percentile reads its own filings.
  const ranks = fm.percentilesFor(bars.S0, lib, { filings: filings.S0 })
  expect(ranks.some(x => x.name === 'filing_sim')).toBe(true)
})

test('…and with no effect it is not admitted', () => {
  const r = rng(9), t0 = Date.UTC(2021, 0, 4), day = i => new Date(t0 + i * 86400000).toISOString().slice(0, 10)
  const bars = {}, filings = {}
  for (let k = 0; k < 40; k++) {
    filings[`S${k}`] = Array.from({ length: 20 }, (_, q) => ({ filed: day(q * 63 + 30), sim: +(0.3 + 0.7 * r()).toFixed(3) }))
    let c = 50 + k
    bars[`S${k}`] = Array.from({ length: 1260 }, (_, i) => { c *= 1 + 0.012 * (r() - 0.5); return { t: t0 + i * 86400000, c, h: c * 1.01, l: c * 0.99, v: 1e6 } })
  }
  const f = fm.mineFactors(bars, { filings, diagnostics: false }).factors.find(x => x.name === 'filing_sim')
  expect(f.verdict).not.toBe('admitted')
})

test('heavy filers: older 10-K/10-Qs on the paged submissions files are listed too', async () => {
  try { fs.unlinkSync(fc.STORE_FILE) } catch {}
  // lib/filings caches the ticker map for a day, so this reuses the ticker loaded above.
  const fetched = []
  const fetchImpl = async url => {
    fetched.push(url)
    const json = body => ({ ok: true, status: 200, json: async () => body })
    if (url.endsWith('company_tickers.json')) return json({ 0: { ticker: 'AAA', cik_str: 1 } })
    if (url.endsWith('CIK0000000001.json')) return json({ filings: {
      recent: recent([['424B2', '2026-09-01', '2026-09-01'], ['10-K', '2026-02-20', '2025-12-31', 'k25']]),
      files: [{ name: 'CIK0000000001-submissions-001.json', filingFrom: '2023-01-01', filingTo: '2025-12-31' },
              { name: 'CIK0000000001-submissions-002.json', filingFrom: '2010-01-01', filingTo: '2015-12-31' }],
    } })
    if (url.endsWith('submissions-001.json')) return json(recent([['10-K', '2025-02-20', '2024-12-31', 'k24'], ['10-Q', '2025-05-01', '2025-03-31', 'q125']]))
    throw new Error(`unexpected ${url}`)
  }
  const { store } = await fc.refresh({ universe: ['AAA'], fetchImpl, budgetMs: -1, now: new Date(Date.UTC(2026, 9, 25)), pauseMs: 0 })
  expect(store.symbols.AAA.filings.map(f => f.accession)).toEqual(['k24', 'q125', 'k25'])
  expect(fetched.some(u => u.endsWith('submissions-002.json'))).toBe(false)   // pages older than the window are skipped
  fs.unlinkSync(fc.STORE_FILE)
})

test('the factor uses 10-K pairs; the dossier compares each form only with the same form', () => {
  const store = { symbols: {} }
  for (let k = 0; k < 12; k++) store.symbols[`S${k}`] = { filings: [
    { form: '10-K', filed: '2026-02-20', sim: 0.5 + k * 0.02 }, { form: '10-Q', filed: '2026-05-01', sim: 0.3 + k * 0.01 },
  ] }
  expect(fc.simsBySymbol(store).S0).toEqual([{ filed: '2026-02-20', form: '10-K', sim: 0.5 }])
  const line = fc.describeFor('S11', store)
  expect(line).toMatch(/the 10-K filed 2026-02-20 repeats about 72% of the 10-K a year earlier \(100th percentile of 12/)
  expect(line).toMatch(/the 10-Q filed 2026-05-01 repeats about 41% .*\(100th percentile of 12/)
  expect(fc.describeFor('S0', store)).toMatch(/\(0th percentile/)
})
