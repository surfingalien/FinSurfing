'use strict'
/**
 * lib/prediction-log-path.js
 *
 * The ONE definition of where AI Brain predictions live. The scanner appends to
 * it (routes/ai-brain.js) and the nightly resolver reads and rewrites it
 * (lib/brain-learnings.js); if those two ever disagree, picks are written to one
 * file and scored from another, and calibration silently measures nothing.
 *
 * AI_BRAIN_PREDICTION_LOG overrides the path — for tests, and for pointing the
 * log at persistent storage, since Railway's filesystem is wiped on every
 * deploy. Server-operator controlled; never derived from user input.
 *
 * Its own module, rather than an export of brain-learnings, because route tests
 * mock brain-learnings wholesale — an export there would vanish under the mock
 * and take the redirect with it.
 */
const path = require('path')

const PREDICTION_LOG = process.env.AI_BRAIN_PREDICTION_LOG
  || path.join(require('./data-dir').DATA_DIR, 'ai-brain-predictions.jsonl')

module.exports = { PREDICTION_LOG }
