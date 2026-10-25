'use strict'
// Discovery admits a validated strategy only if its batch's selection does not overfit (lib/pbo.js).

const mockEvaluate = jest.fn()
const mockRecord = jest.fn(() => ({ fitness: 50, generation: 1 }))
jest.mock('../lib/ai-router', () => ({ getRouter: () => ({ call: async () => ({ text: '[]' }) }) }))
jest.mock('../lib/internal-api', () => ({
  fetchDailyBars: async () => Array.from({ length: 300 }, (_, i) => ({ t: Date.UTC(2024, 0, 1) + i * 86400000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1e6 })),
}))
jest.mock('../lib/strategy-lab', () => ({
  ...jest.requireActual('../lib/strategy-lab'),
  parseProposals: () => [{ strategy: 'sma_crossover', params: { fast: 10, slow: 30 } }],
  evaluateProposals: (...a) => mockEvaluate(...a),
}))
jest.mock('../lib/strategy-library', () => ({ ...jest.requireActual('../lib/strategy-library'), recordValidation: (...a) => mockRecord(...a) }))

const evo = require('../lib/brain-evolution')

const validated = pbo => ({ strategy: 'sma_crossover', params: { fast: 10, slow: 30 }, verdict: 'validated', metrics: { alpha: 5, sharpeRatio: 1 }, deflated: { dsr: 0.9, nTrials: 3, pass: true }, pbo })

beforeEach(() => { mockEvaluate.mockReset(); mockRecord.mockClear() })

test('an overfitting batch is not admitted, and is counted', async () => {
  mockEvaluate.mockReturnValue([validated({ pbo: 0.8, lossRate: 0.7, overfit: true })])
  const r = await evo.discoverStrategies({ symbols: ['AAA'] })
  expect(r).toMatchObject({ validated: 1, overfit: 1, stored: 0 })
  expect(mockRecord).not.toHaveBeenCalled()
})

test('a batch that passes is admitted with its PBO on the admission record', async () => {
  const p = { pbo: 0.1, lossRate: 0.05, overfit: false }
  mockEvaluate.mockReturnValue([validated(p)])
  const r = await evo.discoverStrategies({ symbols: ['AAA'] })
  expect(r).toMatchObject({ overfit: 0, stored: 1 })
  expect(mockRecord.mock.calls[0][1].pbo).toBe(p)
  const entry = jest.requireActual('../lib/strategy-library').buildEntry({ symbol: 'AAA', strategy: 'sma_crossover', params: {}, metrics: { alpha: 5, sharpeRatio: 1 }, verdict: 'validated', deflated: { dsr: 0.9, nTrials: 3, srStar: 0.01 }, pbo: p })
  expect(entry.admission).toEqual({ dsr: 0.9, nTrials: 3, srStar: 0.01, pbo: 0.1 })
})
