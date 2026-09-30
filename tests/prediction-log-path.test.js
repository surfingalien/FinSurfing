'use strict'

// The scanner (routes/ai-brain.js) writes the prediction log and the nightly
// resolver (lib/brain-learnings.js) reads it. Both must resolve the SAME path —
// if only one honours AI_BRAIN_PREDICTION_LOG, the resolver reads a file the
// scanner never wrote and calibration silently goes stale.

const fs   = require('fs')
const os   = require('os')
const path = require('path')

describe('prediction log path', () => {
  const saved = process.env.AI_BRAIN_PREDICTION_LOG
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_BRAIN_PREDICTION_LOG
    else process.env.AI_BRAIN_PREDICTION_LOG = saved
  })

  test('brain-learnings reads the file the override points at', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'predlog-')), 'preds.jsonl')
    process.env.AI_BRAIN_PREDICTION_LOG = tmp
    jest.isolateModules(() => {
      const { PREDICTION_LOG } = require('../lib/prediction-log-path')
      expect(PREDICTION_LOG).toBe(tmp)
      fs.writeFileSync(PREDICTION_LOG, JSON.stringify({ symbol: 'PATHCHECK' }) + '\n')
      const { readPredictions } = require('../lib/brain-learnings')
      expect(readPredictions().map(r => r.symbol)).toEqual(['PATHCHECK'])
    })
  })

  test('defaults to data/ai-brain-predictions.jsonl', () => {
    delete process.env.AI_BRAIN_PREDICTION_LOG
    jest.isolateModules(() => {
      const { PREDICTION_LOG } = require('../lib/prediction-log-path')
      expect(PREDICTION_LOG).toBe(path.join(__dirname, '..', 'data', 'ai-brain-predictions.jsonl'))
    })
  })
})
