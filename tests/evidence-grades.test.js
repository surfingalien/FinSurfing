'use strict'
const desk = require('../lib/research-desk')
const em = require('../lib/exposure-map')

describe('claim grades (Research Desk)', () => {
  const items = [
    { id: 'E1', kind: 'price', text: 'Price $182.40, up 12.5% over 63 sessions.', measured: true },
    { id: 'E2', kind: 'analysts', text: 'Analysts: 42 buy, 6 hold; mean target $215.', measured: false },
    { id: 'E3', kind: 'technicals', text: 'Trend: above the 200-day average; momentum strong and rising.', measured: true },
  ]
  const run = claims => desk.auditClaims(claims, items)
  it('a figure found in measured evidence is confirmed', () => {
    expect(run([{ claim: 'Up 12.5% over 63 sessions', cites: ['E1'] }]).kept[0].grade).toBe('confirmed')
  })
  it('grounded wording with no figure is a supported inference', () => {
    expect(run([{ claim: 'Momentum is strong and rising, trend above the average', cites: ['E3'] }]).kept[0].grade).toBe('supported-inference')
  })
  it('a claim resting only on analyst opinion is third-party', () => {
    expect(run([{ claim: 'Analysts see a mean target of $215', cites: ['E2'] }]).kept[0].grade).toBe('third-party')
  })
  it('a removed claim is unverified', () => {
    const r = run([{ claim: 'Revenue grew 48% last quarter', cites: ['E1'] }])
    expect(r.dropped[0].grade).toBe('unverified')
  })
  it('every grade is explained', () => {
    expect(Object.keys(desk.GRADES)).toEqual(['confirmed', 'supported-inference', 'third-party', 'unverified'])
  })
})

describe('commercial stage on Exposure Map relationships', () => {
  it('reads the stage the quote states, latest first', () => {
    expect(em.commercialStage('Sales to NVIDIA accounted for 19% of our net revenue.').stage).toBe('revenue')
    expect(em.commercialStage('We began volume production of HBM3E for NVIDIA.').stage).toBe('volume')
    expect(em.commercialStage('Our modules are in qualification with a hyperscaler.').stage).toBe('qualification')
    expect(em.commercialStage('We shipped samples to the customer for evaluation.').stage).toBe('sampling')
    expect(em.commercialStage('A joint development agreement with OpenAI.').stage).toBe('development')
  })
  it('names no stage the quote does not state', () => {
    expect(em.commercialStage('SpaceX is a competitor in launch services.')).toBeNull()
  })
  it('buildEdges puts the stage on each edge', () => {
    const edges = em.buildEdges('NVDA', [{ symbol: 'MU', relation: 'supplier', quote: 'We began volume production of HBM3E for NVIDIA in the quarter, our largest new program.', form: '10-K', filedAt: new Date().toISOString().slice(0, 10), url: 'u' }], { minScore: 0 })
    expect(edges[0].stage).toMatchObject({ stage: 'volume' })
  })
})
