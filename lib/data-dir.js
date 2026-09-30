'use strict'

/**
 * lib/data-dir.js — where the learning stores live.
 *
 * One setting for every store under data/ (prediction log, decision log,
 * strategy library, learnings, baseline weights, journals, entity graph, paper
 * book, scan jobs, research theses). FINSURF_DATA_DIR relocates all of them at
 * once; it is server-operator controlled and never derived from user input.
 *
 * The test suite points it at a fresh temp directory (tests/setup-env.js),
 * because route tests exercise code that appends to these stores — the
 * Advisory tests alone were adding ~20 fake decisions to the real decision
 * log per run, and a polluted local store is exactly what a Postgres mirror
 * could carry into the real record. Individual overrides
 * (AI_BRAIN_PREDICTION_LOG, RESEARCH_THESES_LOG) still take precedence.
 */

const path = require('path')

const DATA_DIR = process.env.FINSURF_DATA_DIR
  ? path.resolve(process.env.FINSURF_DATA_DIR)
  : path.join(__dirname, '..', 'data')

module.exports = { DATA_DIR }
