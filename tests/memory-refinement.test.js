'use strict'
/**
 * Unit tests for lib/memory-refinement.js — the reviewable, reversible
 * refinement log behind the AI Brain's memory: diffing, evidence capture,
 * snapshot/revert, tamper-evident chaining, and trimming.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const r    = require('../lib/memory-refinement')

const OVERRIDES = (pinned = [], suppressed = [], note = '') => ({ pinned, suppressed, note })

describe('diffOverrides', () => {
  test('detects pins added and removed', () => {
    const d = r.diffOverrides(OVERRIDES(['a', 'b']), OVERRIDES(['b', 'c']))
    expect(d.pinned.added).toEqual(['c'])
    expect(d.pinned.removed).toEqual(['a'])
  })

  test('suppression matching is case/space-insensitive', () => {
    const d = r.diffOverrides(OVERRIDES([], ['Earnings Risky']), OVERRIDES([], ['  earnings risky  ']))
    expect(r.isEmptyDiff(d)).toBe(true)
  })

  test('note changes are captured from → to', () => {
    const d = r.diffOverrides(OVERRIDES([], [], 'old'), OVERRIDES([], [], 'new'))
    expect(d.note).toEqual({ from: 'old', to: 'new' })
  })

  test('identical states diff to nothing', () => {
    expect(r.isEmptyDiff(r.diffOverrides(OVERRIDES(['x']), OVERRIDES(['x'])))).toBe(true)
  })
})

describe('diffLearnings', () => {
  test('tracks keyLearnings churn and steering-field changes', () => {
    const d = r.diffLearnings(
      { keyLearnings: ['one', 'two'], bestCompositeThreshold: 60, confidenceCalibrated: true },
      { keyLearnings: ['two', 'three'], bestCompositeThreshold: 72, confidenceCalibrated: true },
    )
    expect(d.keyLearnings.added).toEqual(['three'])
    expect(d.keyLearnings.removed).toEqual(['one'])
    expect(d.fields.bestCompositeThreshold).toEqual({ from: 60, to: 72 })
    expect(d.fields.confidenceCalibrated).toBeUndefined() // unchanged → omitted
  })

  test('a nightly rerun with identical conclusions is a no-op', () => {
    const doc = { keyLearnings: ['a'], promptInjection: 'x', bestCompositeThreshold: 70 }
    expect(r.isEmptyDiff(r.diffLearnings(doc, { ...doc }))).toBe(true)
  })
})

describe('summarizeDiff', () => {
  test('renders a compact human summary', () => {
    const d = r.diffOverrides(OVERRIDES(['a']), OVERRIDES(['a', 'b'], ['s'], 'note'))
    const s = r.summarizeDiff('overrides', d)
    expect(s).toContain('+1 pinned')
    expect(s).toContain('+1 suppressed')
    expect(s).toContain('directive set')
  })

  test('empty diff summarises as no change', () => {
    expect(r.summarizeDiff('overrides', {})).toBe('no change')
  })
})

describe('recordRefinement + log', () => {
  let file
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'refine-')), 'log.jsonl') })

  test('records actor, evidence, diff and the prior-state snapshot', () => {
    const before = OVERRIDES(['keep'])
    const after  = OVERRIDES(['keep', 'new'])
    const entry = r.recordRefinement({
      actor: 'human', kind: 'overrides', before, after,
      evidence: 'pinned after Q3 review', file,
    })
    expect(entry.seq).toBe(1)
    expect(entry.actor).toBe('human')
    expect(entry.evidenced).toBe(true)
    expect(entry.evidence.reason).toBe('pinned after Q3 review')
    expect(entry.diff.pinned.added).toEqual(['new'])
    expect(entry.snapshot).toEqual(before) // revert target is the FULL prior state
  })

  test('no-op edits are not logged', () => {
    const s = OVERRIDES(['a'])
    expect(r.recordRefinement({ actor: 'human', kind: 'overrides', before: s, after: s, file })).toBeNull()
    expect(r.readAll(file)).toHaveLength(0)
  })

  test('refinements without evidence are allowed but flagged unevidenced', () => {
    const e = r.recordRefinement({ actor: 'ai', kind: 'overrides', before: OVERRIDES(), after: OVERRIDES(['x']), file })
    expect(e.evidenced).toBe(false)
    expect(e.evidence).toBeNull()
  })

  test('seq increments and entries read newest-first', () => {
    r.recordRefinement({ actor: 'human', kind: 'overrides', before: OVERRIDES(), after: OVERRIDES(['a']), file })
    r.recordRefinement({ actor: 'human', kind: 'overrides', before: OVERRIDES(['a']), after: OVERRIDES(['a', 'b']), file })
    const list = r.readRefinements({ file })
    expect(list.map(e => e.seq)).toEqual([2, 1])
  })

  test('snapshotFor returns the state to restore', () => {
    const before = OVERRIDES(['original'], [], 'keep me')
    r.recordRefinement({ actor: 'human', kind: 'overrides', before, after: OVERRIDES([], [], ''), file })
    const found = r.snapshotFor(1, file)
    expect(found.kind).toBe('overrides')
    expect(found.snapshot).toEqual(before)
    expect(r.snapshotFor(99, file)).toBeNull()
  })
})

describe('tamper-evident chain', () => {
  let file
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'refine-')), 'log.jsonl') })

  const seed = () => {
    r.recordRefinement({ actor: 'human', kind: 'overrides', before: OVERRIDES(), after: OVERRIDES(['a']), file })
    r.recordRefinement({ actor: 'ai', kind: 'overrides', before: OVERRIDES(['a']), after: OVERRIDES(['a', 'b']), file })
    r.recordRefinement({ actor: 'human', kind: 'overrides', before: OVERRIDES(['a', 'b']), after: OVERRIDES(['b']), file })
  }
  const write = entries => fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

  test('an intact chain verifies and links entry to entry', () => {
    seed()
    expect(r.verifyChain(file)).toMatchObject({ valid: true, entries: 3, firstBreak: null })
    const all = r.readAll(file)
    expect(all[0].prevChainHash).toBe(r.GENESIS_HASH)
    expect(all[1].prevChainHash).toBe(all[0].chainHash)
  })

  test('editing a past refinement is detected at that entry', () => {
    seed()
    const all = r.readAll(file)
    all[1].evidence = { reason: 'rewritten history' }
    write(all)
    const v = r.verifyChain(file)
    expect(v.valid).toBe(false)
    expect(v.firstBreak.seq).toBe(2)
  })

  test('deleting a refinement breaks the chain', () => {
    seed()
    const all = r.readAll(file)
    all.splice(1, 1)
    write(all)
    expect(r.verifyChain(file).valid).toBe(false)
  })

  test('an empty log is trivially valid', () => {
    expect(r.verifyChain(file)).toMatchObject({ valid: true, entries: 0 })
  })
})
