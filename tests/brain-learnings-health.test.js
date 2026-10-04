'use strict'

// buildLearnings: the audited block, its version stamp, and withholding.

const fs = require('fs')
const path = require('path')
const bl = require('../lib/brain-learnings')
const { evaluateStatus } = require('../lib/system-status')

const LEARNINGS = path.join(require('../lib/data-dir').DATA_DIR, 'brain-learnings.json')
const seg = (k, n) => ({ n, nBench: n, alphaWins: k, alphaWinRate: +(k / n).toFixed(3), wins: k, winRate: +(k / n).toFixed(3) })

function write(doc) {
  fs.mkdirSync(path.dirname(LEARNINGS), { recursive: true })
  fs.writeFileSync(LEARNINGS, JSON.stringify({ updatedAt: new Date().toISOString(), totalResolved: 200, scoreWeightAdjustments: {}, ...doc }))
}

const stats = {
  byVolumeSignal: { Confirming: seg(70, 100), Weak: seg(20, 50), Diverging: seg(20, 50) },
  conflictImpact: { conflict: seg(26, 50), noConflict: seg(25, 50) },
}

afterAll(() => { try { fs.unlinkSync(LEARNINGS) } catch { /* absent */ } })

test('an unestablished flag and an uncited finding never reach the prompt', () => {
  write({
    stats,
    keyLearnings: ['Confirming volume beat the benchmark 70% of the time [byVolumeSignal.Confirming]', 'Trust your gut on tech'],
    volumeConfirmationPredictive: true,
    conflictSignalUseful: true,          // 52% vs 50% of 50 — not established
  })
  const { block, version } = bl.buildLearnings()
  expect(block).toMatch(/Volume confirmation .* YES/)
  expect(block).not.toMatch(/Agent conflict signal useful/)
  expect(block).toMatch(/Confirming volume beat the benchmark 70%/)
  expect(block).not.toMatch(/Trust your gut/)
  expect(version).toMatch(/^[0-9a-f]{8}$/)
})

test('the version follows what steers the model, not the rates', () => {
  write({ stats, keyLearnings: ['Confirming leads [byVolumeSignal.Confirming]'], volumeConfirmationPredictive: true })
  const a = bl.buildLearnings().version
  write({ stats, keyLearnings: ['Confirming leads [byVolumeSignal.Confirming]'], volumeConfirmationPredictive: true, totalResolved: 999 })
  expect(bl.buildLearnings().version).toBe(a)
  write({ stats, keyLearnings: ['Confirming leads [byVolumeSignal.Confirming]'], volumeConfirmationPredictive: false })
  expect(bl.buildLearnings().version).not.toBe(a)   // contradicted → dropped → a different directive set
})

test('when picks made with the learnings did measurably worse, the block is withheld and stamped none', () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  write({
    stats: { ...stats, byLearnings: { on: seg(30, 100), off: seg(60, 100) } },
    keyLearnings: ['Confirming leads [byVolumeSignal.Confirming]'],
  })
  const out = bl.buildLearnings()
  expect(out).toMatchObject({ block: '', version: 'none', withheld: true })
  const status = evaluateStatus({ learningHealth: bl.getLearningHealth() })
  expect(status.checks.find(c => c.id === 'learning-health')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Withheld/) })
  console.warn.mockRestore()
})

test('computeStats splits picks by whether learnings were injected; unstamped records are excluded', () => {
  const t = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const r = (v, win) => ({ symbol: 'X', generatedAt: t, basePrice: 100, price7d: win ? 110 : 90, benchRet7d: 0, learningsVersion: v })
  const s = bl.computeStats([r('abcd1234', true), r('abcd1234', false), r('none', true), { ...r(undefined, true), learningsVersion: undefined }])
  expect(s.byLearnings.on.n).toBe(2)
  expect(s.byLearnings.off.n).toBe(1)
})

test('with no learnings file at all (a fresh deploy), it returns an empty block — never a bare string', () => {
  try { fs.unlinkSync(LEARNINGS) } catch { /* absent */ }
  const out = bl.buildLearnings()
  expect(out).toMatchObject({ block: '', version: 'none', withheld: false })
  expect(bl.getLearningsBlock()).toBe('')
})
