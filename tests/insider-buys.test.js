'use strict'
// Insider purchases: routine vs opportunistic vs plan, clusters, and the measured study.

const fs = require('fs')
const zlib = require('zlib')
const ib = require('../lib/insider-buys')
const { readZip } = require('../lib/zip-read')

/** A minimal deflated zip, so the reader is tested on real structure. */
function makeZip(files) {
  const locals = [], central = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), comp = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lh, nameBuf, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const SUB_H = 'ACCESSION_NUMBER\tFILING_DATE\tDOCUMENT_TYPE\tISSUERTRADINGSYMBOL\tAFF10B5ONE'
const OWN_H = 'ACCESSION_NUMBER\tRPTOWNERCIK\tRPTOWNERNAME\tRPTOWNER_RELATIONSHIP\tRPTOWNER_TITLE'
const TR_H = 'ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE\tTRANS_ACQUIRED_DISP_CD'

test('zip entries read back exactly; dates parse; TSV parses', () => {
  const z = readZip(makeZip({ 'A.tsv': 'x\ty\n1\t2\n', 'B.txt': 'skip me' }), n => n.endsWith('.tsv'))
  expect(Object.keys(z)).toEqual(['A.tsv'])
  expect(ib.parseTsv(z['A.tsv'].toString())).toEqual([{ x: '1', y: '2' }])
  expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/not a zip/)
  expect(ib.isoDate('31-JUL-2026')).toBe('2026-07-31')
  expect(ib.isoDate('2026-07-31')).toBe('2026-07-31')
  expect(ib.isoDate('7/31/2026')).toBeNull()
})

test('one row per original Form 4 purchase: sales, amendments and zero prices are dropped; lots aggregate', () => {
  const rows = ib.purchasesFromFiles({
    submission: [SUB_H, 'A1\t31-JUL-2026\t4\tABC\t0', 'A2\t31-JUL-2026\t4/A\tABC\t0', 'A3\t01-AUG-2026\t4\tXYZ\ttrue', 'A4\t01-AUG-2026\t4\tXYZ\t0'].join('\n'),
    owners: [OWN_H, 'A1\t0000001\tJane CEO\tOfficer\tCEO', 'A1\t0000002\tJane Trust\tOther\t', 'A2\t1\tJane\tOfficer\tCEO', 'A3\t3\tBob\tDirector\t', 'A4\t4\tAl\tDirector\t'].join('\n'),
    trans: [TR_H,
      'A1\t29-JUL-2026\tP\t100\t10\tA', 'A1\t28-JUL-2026\tP\t300\t12\tA',   // two lots → 400 shares, VWAP 11.5, earliest 07-28
      'A2\t29-JUL-2026\tP\t999\t10\tA',                                     // amendment
      'A3\t30-JUL-2026\tP\t50\t20\tA',                                      // 10b5-1 plan
      'A4\t30-JUL-2026\tS\t50\t20\tD', 'A4\t30-JUL-2026\tP\t50\t0\tA'].join('\n'),
  })
  expect(rows).toHaveLength(2)
  const a = rows.find(r => r[9] === 'A1')
  expect(a).toEqual(['2026-07-31', '2026-07-28', 'ABC', '1', 'officer', 'CEO', 400, 11.5, 0, 'A1'])
  expect(rows.find(r => r[9] === 'A3')[8]).toBe(1)
})

// row: [filed, traded, symbol, owner, role, title, shares, price, plan, accession]
const buy = (traded, symbol, owner, { price = 20, shares = 1000, plan = 0, filed = null } = {}) =>
  [filed || traded, traded, symbol, owner, 'director', '', shares, price, plan, `${symbol}-${owner}-${traded}`]

test('routine = same stock, same month, each of the three prior years; else opportunistic; plan batches excluded', () => {
  const rows = [
    ...[2023, 2024, 2025].map(y => buy(`${y}-03-10`, 'ROU', '1')), buy('2026-03-12', 'ROU', '1'),   // routine March buyer
    buy('2024-03-10', 'OPP', '2'), buy('2026-03-12', 'OPP', '2'),                                    // missed 2023 and 2025 → opportunistic
    ...['a', 'b', 'c', 'd', 'e'].map(o => buy('2026-05-01', 'ESP', o, { price: 15 })),                // stock-plan batch
    buy('2026-05-02', 'PLN', '9', { plan: 1 }),                                                       // 10b5-1 flagged
    buy('2026-05-02', 'TNY', '8', { price: 3 }), buy('2026-05-02', 'SML', '7', { shares: 100 }),     // under $5 / under $10k: dropped
  ]
  const c = ib.classify(rows, { coverageStart: '2023-01-01' })
  const cls = (sym, d) => c.find(b => b.symbol === sym && b.traded === d)?.cls
  expect(cls('ROU', '2026-03-12')).toBe('routine')
  expect(cls('OPP', '2026-03-12')).toBe('opportunistic')
  expect(c.filter(b => b.symbol === 'ESP').every(b => b.cls === 'plan')).toBe(true)
  expect(cls('PLN', '2026-05-02')).toBe('plan')
  expect(c.some(b => b.symbol === 'TNY' || b.symbol === 'SML')).toBe(false)
  // Not enough history before a buy: cannot tell routine from opportunistic.
  expect(ib.classify([buy('2024-03-10', 'NEW', '3')], { coverageStart: '2023-01-01' })[0].cls).toBe('unclassified')
})

test('events: one per group per 30 days; a cluster fires on the third distinct non-plan buyer', () => {
  const rows = [
    buy('2026-06-01', 'CLU', '1'), buy('2026-06-05', 'CLU', '1'),          // same insider twice — not a second buyer
    buy('2026-06-10', 'CLU', '2'),
    ...['p', 'q', 'r', 's', 't'].map(o => buy('2026-06-12', 'CLU', o, { price: 18 })),   // plan batch: not cluster members
    buy('2026-06-20', 'CLU', '3'),                                          // third real buyer → cluster
    buy('2026-08-15', 'CLU', '4'),
  ]
  const ev = ib.buildEvents(ib.classify(rows, { coverageStart: '2020-01-01' }))
  const of = g => ev.filter(e => e.group === g)
  expect(of('cluster')).toHaveLength(1)
  expect(of('cluster')[0]).toMatchObject({ date: '2026-06-20', insiders: 3 })
  expect(of('opportunistic').map(e => e.date)).toEqual(['2026-06-01', '2026-08-15'])   // 06-05/06-10/06-20 fall inside 30 days
  expect(of('plan')).toHaveLength(1)
})

test('the verdict needs older AND newer events positive with t ≥ 2; noise is not validated', () => {
  const ev = (n, f) => Array.from({ length: n }, (_, i) => ({ entryDate: new Date(Date.UTC(2023, 0, 1) + i * 9 * 86400000).toISOString().slice(0, 10), abn: f(i) }))
  expect(ib.verdictFor(ev(120, i => 2 + ((i * 37) % 11) - 5)).verdict).toBe('validated')
  expect(['rejected', 'mixed']).toContain(ib.verdictFor(ev(120, i => ((i * 37) % 11) - 5)).verdict)
  expect(ib.verdictFor(ev(12, () => 3)).verdict).toBe('insufficient')
})

describe('the weekly study end to end', () => {
  const DAY = 86400000
  const bars = (drift, start = Date.UTC(2025, 0, 1), n = 500) => Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, o: 100 * (1 + drift) ** i, c: 100 * (1 + drift) ** i }))
  const quarterZip = rows => makeZip({
    'SUBMISSION.tsv': [SUB_H, ...rows.map(r => `${r.acc}\t${r.filed}\t4\t${r.sym}\t0`)].join('\n'),
    'REPORTINGOWNER.tsv': [OWN_H, ...rows.map(r => `${r.acc}\t${r.owner}\tX\tDirector\t`)].join('\n'),
    'NONDERIV_TRANS.tsv': [TR_H, ...rows.map(r => `${r.acc}\t${r.filed}\tP\t1000\t20\tA`)].join('\n'),
  })
  // Three insiders buy CLU together every month of 2025 Q2; LON gets lone buys.
  const fmt = d => { const x = new Date(d); return `${String(x.getUTCDate()).padStart(2, '0')}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][x.getUTCMonth()]}-${x.getUTCFullYear()}` }
  const q2 = []
  for (const [m, d] of [[3, 2], [4, 6], [5, 9]]) {
    for (const o of ['1', '2', '3']) q2.push({ acc: `C${m}${o}`, filed: fmt(Date.UTC(2025, m, d + Number(o))), sym: 'CLU', owner: o })
    q2.push({ acc: `L${m}`, filed: fmt(Date.UTC(2025, m, d)), sym: 'LON', owner: '9' })
  }
  const fetchImpl = async url => (/2025q2_form345/.test(url) && /datastandardsinnovation/.test(url)
    ? { ok: true, status: 200, arrayBuffer: async () => quarterZip(q2) }
    : { ok: false, status: 404 })
  afterEach(() => { for (const f of [ib.STORE_FILE, ib.STUDY_FILE]) try { fs.unlinkSync(f) } catch {} })

  test('downloads a quarter once, prices the active names, measures clusters vs IWM, persists', async () => {
    const fetchBars = async s => (s === 'IWM' ? bars(0) : s === 'CLU' ? bars(0.002) : bars(0))
    const now = new Date(Date.UTC(2025, 9, 15))
    const out = await ib.runStudy({ fetchBars, fetchImpl, now, minUniverse: 1 })
    expect(out.added).toEqual(['2025q2'])
    expect(out.purchases).toBe(12)
    expect(out.groups.cluster.n).toBe(3)
    expect(out.groups.cluster.meanAbn).toBeGreaterThan(3)       // ~0.2%/day for 20 sessions
    expect(ib.readStudy().ranAt).toBe(out.ranAt)
    // A second run re-downloads nothing.
    const calls = []
    const again = await ib.runStudy({ fetchBars, fetchImpl: async u => { calls.push(u); return fetchImpl(u) }, now, minUniverse: 1 })
    expect(again.added).toEqual([])
    expect(calls.some(u => /2025q2/.test(u))).toBe(false)
  })

  test('a run that can price too few names keeps the stored study', async () => {
    const now = new Date(Date.UTC(2025, 9, 15))
    await ib.runStudy({ fetchBars: async s => bars(0), fetchImpl, now, minUniverse: 1 })
    const before = ib.readStudy()
    await expect(ib.runStudy({ fetchBars: async s => (s === 'IWM' ? bars(0) : []), fetchImpl, now, minUniverse: 2 })).rejects.toThrow(/stored study is kept/)
    expect(ib.readStudy()).toEqual(before)
  })

  test('the dossier line names the buys, flags a cluster and quotes the verdicts', async () => {
    const now = new Date(Date.UTC(2025, 6, 5))      // Q2's file is published once Q2 has ended
    await ib.runStudy({ fetchBars: async () => bars(0), fetchImpl, now, minUniverse: 1 })
    const r = ib.recentFor('CLU', { now, days: 60 })
    expect(r.purchases).toBe(3 + 3)                 // May + June batches within 60 days of 07-05
    expect(r.cluster).toBe(true)
    const line = ib.describeRecent(r)
    expect(line).toMatch(/CLUSTER/)
    expect(line).toMatch(/opportunistic buys .*; cluster buys/)
    expect(ib.recentFor('NONE', { now })).toBeNull()
    expect(ib.describeRecent(null)).toBeNull()
  })
})

test('quarter keys never include the current (unpublished) quarter', () => {
  expect(ib.quarterKeys(new Date(Date.UTC(2026, 9, 25)), 3)).toEqual(['2026q3', '2026q2', '2026q1', '2025q4'])
  expect(ib.quarterStart('2026q3')).toBe('2026-07-01')
})

test('coverage starts after a missing quarter, so a gap cannot turn routine buyers opportunistic', async () => {
  const zip = makeZip({ 'SUBMISSION.tsv': SUB_H, 'REPORTINGOWNER.tsv': OWN_H, 'NONDERIV_TRANS.tsv': TR_H })
  const fetchImpl = async url => {
    const k = url.match(/(\d{4}q\d)_form345/)[1]
    if (k === '2026q1') return { ok: false, status: 500 }                      // a failed download
    if (k === '2026q4' || !/datastandardsinnovation/.test(url)) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => zip }
  }
  try {
    const { store, added, errors } = await ib.refreshStore({ fetchImpl, quarters: 4, now: new Date(Date.UTC(2026, 9, 25)), save: false })
    expect(added).toEqual(['2026q3', '2026q2', '2025q4', '2025q3'])
    expect(errors.join()).toMatch(/2026q1: HTTP 500/)
    expect(store.coverageStart).toBe('2026-04-01')                              // the unbroken run is 2026q2–q3
  } finally { try { fs.unlinkSync(ib.STORE_FILE) } catch {} }
})
