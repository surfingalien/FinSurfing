const { diffScans, findComparable, scanKey, SCORE_MOVE } = require('../lib/scan-diff')

const stock = (symbol, agentVerdict, compositeScore, extra = {}) => ({ symbol, agentVerdict, compositeScore, ...extra })
const scan = (stocks, extra = {}) => ({
  rankedStocks: stocks, processedAt: '2026-11-10T14:00:00.000Z',
  universeAnalyzed: stocks.map(s => s.symbol), unpricedSymbols: [], ...extra,
})

describe('diffScans', () => {
  test('a verdict that moved is a change; buy → Avoid is high severity', () => {
    const d = diffScans(
      scan([stock('NVDA', 'Strong Buy', 82), stock('AMD', 'Buy', 70)]),
      scan([stock('NVDA', 'Avoid', 35, { actionable: false }), stock('AMD', 'Moderate Buy', 66)]),
    )
    expect(d.changed.map(c => [c.symbol, c.from, c.to, c.severity])).toEqual([
      ['NVDA', 'Strong Buy', 'Avoid', 'high'],
      ['AMD', 'Buy', 'Moderate Buy', 'normal'],
    ])
    expect(d.nothingChanged).toBe(false)
  })

  test('same verdict: only a score move of SCORE_MOVE or more is reported', () => {
    const d = diffScans(
      scan([stock('A', 'Buy', 60), stock('B', 'Buy', 60), stock('C', 'Buy', null)]),
      scan([stock('A', 'Buy', 60 + SCORE_MOVE), stock('B', 'Buy', 60 + SCORE_MOVE - 1), stock('C', 'Buy', 90)]),
    )
    expect(d.rescored.map(r => r.symbol)).toEqual(['A'])
    expect(d.rescored[0].move).toBe(SCORE_MOVE)
    expect(d.unchanged).toBe(2)   // B moved less; C has no earlier score to compare — never a move
  })

  test('a dropped name says whether the model looked at it again', () => {
    const prev = scan([stock('KEPT', 'Buy', 70), stock('LEFT', 'Buy', 70), stock('NOPRICE', 'Buy', 70), stock('ROTATED', 'Buy', 70)])
    const curr = scan([stock('KEPT', 'Buy', 70)], { universeAnalyzed: ['KEPT', 'LEFT'], unpricedSymbols: ['NOPRICE'] })
    const d = diffScans(prev, curr)
    expect(Object.fromEntries(d.dropped.map(x => [x.symbol, x.reason]))).toEqual({
      LEFT: 'not-picked', NOPRICE: 'unpriced', ROTATED: 'not-in-list',
    })
    expect(d.dropped[0].symbol).toBe('LEFT')   // the one that is a view comes first
  })

  test('an added name says whether the previous scan had analysed it', () => {
    const prev = scan([stock('A', 'Buy', 70)], { universeAnalyzed: ['A', 'SEEN'] })
    const d = diffScans(prev, scan([stock('A', 'Buy', 70), stock('SEEN', 'Buy', 75), stock('NEW', 'Buy', 80)]))
    expect(d.added.map(x => [x.symbol, x.seenBefore])).toEqual([['NEW', false], ['SEEN', true]])
  })

  test('identical scans: nothing changed', () => {
    const s = scan([stock('A', 'Buy', 70)])
    const d = diffScans(s, s)
    expect(d.nothingChanged).toBe(true)
    expect(d.unchanged).toBe(1)
  })

  test('empty and missing scans do not throw', () => {
    expect(diffScans(null, scan([])).nothingChanged).toBe(true)
    expect(diffScans(scan([stock('A', 'Buy', 1)]), {}).dropped).toHaveLength(1)
  })

  test('the regime line appears only when the two scans worded it differently', () => {
    expect(diffScans(scan([], { marketRegime: 'Risk-on' }), scan([], { marketRegime: 'Risk-on' })).regime).toBeNull()
    expect(diffScans(scan([], { marketRegime: 'Risk-on' }), scan([], { marketRegime: 'Late cycle' })).regime).toEqual({ from: 'Risk-on', to: 'Late cycle' })
  })
})

describe('findComparable', () => {
  const job = (at, params, extra = {}) => ({ status: 'done', params, result: { processedAt: at, rankedStocks: [], ...extra } })

  test('previous = the newest earlier scan of the same mode and horizon', () => {
    const jobs = [
      job('t5', { scanMode: 'broad', horizon: '6m' }),
      job('t4', { scanMode: 'stocks_tech', horizon: '6m' }),
      job('t3', { scanMode: 'broad', horizon: '3m' }),
      job('t2', { scanMode: 'broad', horizon: '6m' }),
      job('t1', { scanMode: 'broad', horizon: '6m' }),
    ]
    const { current, previous } = findComparable(jobs)
    expect(current.result.processedAt).toBe('t5')
    expect(previous.result.processedAt).toBe('t2')
    expect(findComparable(jobs, 't4').previous).toBeNull()
    expect(findComparable(jobs, 'nope').current).toBeNull()
  })

  test('failed jobs and error bodies are never a baseline', () => {
    const jobs = [
      job('t3', { scanMode: 'broad', horizon: '6m' }),
      { status: 'failed', params: { scanMode: 'broad', horizon: '6m' }, result: null },
      job('t2', { scanMode: 'broad', horizon: '6m' }, { error: 'boom' }),
      job('t1', { scanMode: 'broad', horizon: '6m' }),
    ]
    expect(findComparable(jobs).previous.result.processedAt).toBe('t1')
  })

  test('explicit symbol lists compare only with the same list, in any order', () => {
    expect(scanKey({ symbols: ['msft', 'AAPL'], horizon: '6m' })).toBe(scanKey({ symbols: ['AAPL', 'MSFT'], horizon: '6m' }))
    expect(scanKey({ symbols: ['AAPL'], horizon: '6m' })).not.toBe(scanKey({ scanMode: 'broad', horizon: '6m' }))
  })
})
