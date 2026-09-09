'use strict'
/**
 * Unit tests for lib/entity-graph.js.
 *
 * The diff is the point of the module — a supplier that STOPS naming a customer
 * is reporting a lost relationship, usually before the revenue line does — so
 * most of these pin the transition semantics rather than the storage.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const {
  MATERIALITY_EPSILON, edgeKey, diffEdges, diffBlock,
  readAll, latestEdges, writeSnapshot, trackedAnchors,
} = require('../lib/entity-graph')

const edge = (symbol, over = {}) => ({
  anchor: 'SPACEX', symbol, relation: 'supplier', score: 80, materialityPct: null,
  evidence: { quote: 'q', form: '10-K', filedAt: '2026-02-14', url: 'http://x', verified: true },
  ...over,
})

let tmpFile
beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-')), 'entity-graph.jsonl')
})

describe('edgeKey', () => {
  test('is case-insensitive on anchor and symbol, and includes the relation', () => {
    expect(edgeKey({ anchor: 'spacex', symbol: 'rklb', relation: 'supplier' }))
      .toBe(edgeKey({ anchor: 'SPACEX', symbol: 'RKLB', relation: 'supplier' }))
    expect(edgeKey({ anchor: 'A', symbol: 'B', relation: 'supplier' }))
      .not.toBe(edgeKey({ anchor: 'A', symbol: 'B', relation: 'competitor' }))
  })
})

describe('diffEdges', () => {
  test('a newly disclosed relationship is reported as added', () => {
    const d = diffEdges([], [edge('RKLB')])
    expect(d.added).toHaveLength(1)
    expect(d.added[0]).toMatchObject({ type: 'added', symbol: 'RKLB' })
    expect(d.changed).toBe(1)
  })

  test('a relationship that disappears is reported as dropped — the signal', () => {
    const d = diffEdges([edge('RKLB', { materialityPct: 34 })], [])
    expect(d.dropped).toHaveLength(1)
    expect(d.dropped[0]).toMatchObject({ type: 'dropped', symbol: 'RKLB', lastMaterialityPct: 34 })
  })

  test('an unchanged relationship produces no row at all', () => {
    const prev = [edge('RKLB', { materialityPct: 34 })]
    const d = diffEdges(prev, [edge('RKLB', { materialityPct: 34 })])
    expect(d.changed).toBe(0)
    expect(d.added).toEqual([])
    expect(d.dropped).toEqual([])
  })

  test('a materially larger disclosed share is reported with its direction', () => {
    const d = diffEdges([edge('RKLB', { materialityPct: 20 })], [edge('RKLB', { materialityPct: 34 })])
    expect(d.materialityMoved).toHaveLength(1)
    expect(d.materialityMoved[0]).toMatchObject({ type: 'materiality_up', from: 20, to: 34, deltaPct: 14 })
  })

  test('a shrinking share is reported as materiality_down', () => {
    const d = diffEdges([edge('RKLB', { materialityPct: 34 })], [edge('RKLB', { materialityPct: 20 })])
    expect(d.materialityMoved[0].type).toBe('materiality_down')
  })

  test('sub-epsilon wobble is disclosure noise, not a change', () => {
    const d = diffEdges(
      [edge('RKLB', { materialityPct: 34 })],
      [edge('RKLB', { materialityPct: 34 + MATERIALITY_EPSILON / 2 })])
    expect(d.materialityMoved).toEqual([])
    expect(d.changed).toBe(0)
  })

  test('the same symbol changing relation is a drop plus an add, not an edit', () => {
    const d = diffEdges([edge('AVGO', { relation: 'supplier' })], [edge('AVGO', { relation: 'competitor' })])
    expect(d.dropped).toHaveLength(1)
    expect(d.added).toHaveLength(1)
  })

  test('handles empty and missing inputs without throwing', () => {
    expect(diffEdges().changed).toBe(0)
    expect(diffEdges(null, null).changed).toBe(0)
  })

  test('a relationship first disclosing a percentage is not a materiality move', () => {
    // null -> 34 is new information, but there is no prior number to move FROM.
    const d = diffEdges([edge('RKLB')], [edge('RKLB', { materialityPct: 34 })])
    expect(d.materialityMoved).toEqual([])
  })
})

describe('diffBlock', () => {
  test("returns '' when nothing moved, so callers never announce a non-event", () => {
    expect(diffBlock('SPACEX', diffEdges([], []))).toBe('')
    expect(diffBlock('SPACEX', null)).toBe('')
  })

  test('leads with the dropped relationships', () => {
    const d = diffEdges([edge('RKLB', { materialityPct: 34 })], [edge('NEW')])
    const block = diffBlock('SPACEX', d)
    expect(block).toMatch(/RKLB NO LONGER names SPACEX/)
    expect(block).toMatch(/34% of revenue/)
    expect(block.indexOf('RKLB')).toBeLessThan(block.indexOf('NEW'))
  })
})

describe('persistence', () => {
  test('a snapshot round-trips and is stamped with the anchor', () => {
    expect(writeSnapshot('spacex', [edge('RKLB')], { file: tmpFile })).toBe(1)
    const rows = readAll(tmpFile)
    expect(rows).toHaveLength(1)
    expect(rows[0].anchor).toBe('SPACEX')
    expect(rows[0].snapshotAt).toBeTruthy()
  })

  test('later snapshots win — latestEdges reflects the newest run', () => {
    writeSnapshot('SPACEX', [edge('RKLB', { score: 50 })], { file: tmpFile })
    writeSnapshot('SPACEX', [edge('RKLB', { score: 90 })], { file: tmpFile })
    const latest = latestEdges('SPACEX', tmpFile)
    expect(latest).toHaveLength(1)
    expect(latest[0].score).toBe(90)
  })

  test('history is preserved on disk even though only the latest is read back', () => {
    writeSnapshot('SPACEX', [edge('RKLB', { score: 50 })], { file: tmpFile })
    writeSnapshot('SPACEX', [edge('RKLB', { score: 90 })], { file: tmpFile })
    expect(readAll(tmpFile)).toHaveLength(2)
  })

  test('anchors do not leak into each other', () => {
    writeSnapshot('SPACEX', [edge('RKLB')], { file: tmpFile })
    writeSnapshot('NVDA', [edge('AVGO', { anchor: 'NVDA' })], { file: tmpFile })
    expect(latestEdges('SPACEX', tmpFile).map(e => e.symbol)).toEqual(['RKLB'])
    expect(latestEdges('NVDA', tmpFile).map(e => e.symbol)).toEqual(['AVGO'])
  })

  test('an empty snapshot writes nothing', () => {
    expect(writeSnapshot('SPACEX', [], { file: tmpFile })).toBe(0)
    expect(readAll(tmpFile)).toEqual([])
  })

  test('a corrupt line is skipped rather than failing the read', () => {
    writeSnapshot('SPACEX', [edge('RKLB')], { file: tmpFile })
    fs.appendFileSync(tmpFile, 'not json at all\n')
    writeSnapshot('SPACEX', [edge('MDA')], { file: tmpFile })
    expect(readAll(tmpFile)).toHaveLength(2)
  })

  test('a missing file reads as empty, not as an error', () => {
    expect(readAll(path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl'))).toEqual([])
    expect(latestEdges('SPACEX', path.join(os.tmpdir(), 'nope.jsonl'))).toEqual([])
  })

  test('trackedAnchors summarises what has been mapped', () => {
    writeSnapshot('SPACEX', [edge('RKLB'), edge('MDA')], { file: tmpFile })
    writeSnapshot('NVDA', [edge('AVGO', { anchor: 'NVDA' })], { file: tmpFile })
    const tracked = trackedAnchors(tmpFile)
    expect(tracked.map(t => t.anchor).sort()).toEqual(['NVDA', 'SPACEX'])
    expect(tracked.find(t => t.anchor === 'SPACEX').edges).toBe(2)
    expect(tracked.every(t => t.lastRun)).toBe(true)
  })
})
