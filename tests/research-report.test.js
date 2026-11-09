'use strict'
const RR = require('../lib/research-report')
const desk = require('../lib/research-desk')

const items = [
  { id: 'E1', kind: 'price', label: 'Price', text: 'AAA last close $100.00 (2026-11-06).', measured: true, source: 'bars' },
  { id: 'E2', kind: 'analysts', label: 'Analysts', text: 'Analysts: 30 buy, 5 hold, 1 sell; mean target $140.', measured: false, source: 'FMP' },
  { id: 'E3', kind: 'reported', label: 'Reported', text: 'Revenue grew 12.5% year over year. <script>alert(1)</script>', measured: true },
]

describe('variant view', () => {
  test('normalised from model output; an unusable one is null', () => {
    const v = desk.cleanVariant({ consensus: { claim: 'Analysts expect upside, mean target $140.', cites: ['e2'] }, differsOn: 'Valuation', view: 'x', checkByDays: 45, wrongIf: 'y' })
    expect(v).toMatchObject({ differsOn: 'valuation', checkByDays: 90, consensus: { cites: ['E2'] } })
    expect(desk.cleanVariant({})).toBeNull()
  })

  test('the consensus line is checked against the evidence it cites; agreeing is a legitimate answer', () => {
    const at = new Date('2026-11-09T00:00:00Z')
    const ok = desk.judgeVariant({ consensus: { claim: 'Analysts expect upside with a mean target of $140.', cites: ['E2'] }, differsOn: 'fundamentals', view: 'Revenue grew 12.5% year over year, faster than the targets imply.', checkByDays: 90, wrongIf: 'next quarter revenue growth below 5%' }, items, { at })
    expect(ok).toMatchObject({ status: 'stated', checkBy: '2027-02-07' })
    const wrongCite = desk.judgeVariant({ consensus: { claim: 'Analysts expect a mean target of $140.', cites: ['E1'] }, differsOn: 'valuation', view: 'cheap', checkByDays: 30, wrongIf: 'z' }, items, { at })
    expect(wrongCite.status).toBe('unsupported')
    expect(wrongCite.consensus).toBeNull()
    expect(desk.judgeVariant({ consensus: { claim: 'Analysts expect upside with a mean target of $140.', cites: ['E2'] }, differsOn: 'none', view: 'agree', checkByDays: 90, wrongIf: '' }, items, { at }).status).toBe('agrees')
    const madeUp = desk.judgeVariant({ consensus: { claim: 'Analysts expect upside with a mean target of $140.', cites: ['E2'] }, differsOn: 'valuation', view: 'Margins will reach 47.3% next year.', checkByDays: 90, wrongIf: 'w' }, items, { at })
    expect(madeUp.view).toBeNull()
    expect(madeUp.viewRemoved).toBeTruthy()
  })

  test('the thesis prompt asks for it, and the judge attaches it', () => {
    expect(desk.buildThesisPrompt({ symbol: 'AAA', items })).toMatch(/variant — say exactly where you differ from consensus/)
    const t = desk.parseThesis(JSON.stringify({ stance: 'avoid', summary: '', bull: [], bear: [], targetReturn: 0, stopLoss: 0, horizonDays: 30, invalidation: '', variant: { consensus: { claim: 'Analysts expect a mean target of $140.', cites: ['E2'] }, differsOn: 'none', view: 'agree', checkByDays: 30, wrongIf: '' } }))
    const j = desk.judgeThesis({ thesis: t, items, lastPrice: 100, assetType: 'stock', winProb: { p: 0.5, source: 'default', n: 0 } })
    expect(j.variant.status).toBe('agrees')
  })
})

describe('downloadable research report', () => {
  const dossier = { symbol: 'AAA', company: 'Acme & Co', lastPrice: 100, asOf: '2026-11-06', evidence: items, gaps: ['macro: unavailable'] }

  test('evidence only: every item listed with its id, opinions marked, and everything escaped', () => {
    const html = RR.buildReport({ dossier, generatedAt: '2026-11-09T10:00:00Z' })
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('Acme &amp; Co')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(html).toMatch(/third-party opinion/)
    expect(html).toMatch(/No thesis was written/)
    expect(html).toContain('macro: unavailable')
  })

  test('with a thesis: verdict, verified claims, removed claims and the variant view', () => {
    const thesis = { method: 'single', at: '2026-11-09T10:00:00Z', judgement: {
      verdict: 'no-trade', reasons: ['no bull claim survived'], summary: 'S', bull: [], bear: [{ claim: 'Bear', cites: ['E3'] }],
      droppedClaims: [{ side: 'bull', claim: 'Made up 47%', reason: 'figure not in the evidence' }],
      variant: { status: 'stated', consensus: { claim: 'Mean target $140', cites: ['E2'] }, differsOn: 'valuation', view: 'V', checkBy: '2027-02-07', wrongIf: 'W' },
    } }
    const html = RR.buildReport({ dossier, thesis })
    expect(html).toMatch(/No trade/)
    expect(html).toMatch(/Removed by the checks/)
    expect(html).toMatch(/Wrong if, by 2027-02-07/)
    expect(RR.reportFileName('BRK.B', '2026-11-09')).toBe('BRK.B-research-2026-11-09.html')
  })

  test('refuses without a dossier', () => {
    expect(() => RR.buildReport({})).toThrow(/dossier/)
  })
})
