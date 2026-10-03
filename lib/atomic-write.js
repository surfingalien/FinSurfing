'use strict'

/**
 * lib/atomic-write.js — crash-safe writes for the learning stores, and the
 * rule that "could not read" is never "nothing there".
 *
 * Every store under data/ (prediction log, learning store, strategy library,
 * paper book, learnings…) used to be rewritten IN PLACE with writeFileSync. A
 * deploy or crash mid-write leaves a truncated file; the readers then skip
 * every line they cannot parse (or fall back to an empty default), so the
 * missing rows read as rows that never existed — and the next rewrite, and the
 * durable-files mirror, make that loss permanent.
 *
 *   writeFileAtomic   temp file in the same directory → fsync → rename, so a
 *                     reader sees the old bytes or the new bytes, never half.
 *   inspectJsonl      tells a TRUNCATED TAIL (an append the crash cut short —
 *                     never acknowledged, safe to drop) from a CORRUPT MIDDLE
 *                     line (real rows that can no longer be read).
 *   quarantineIfDamaged  before anything overwrites a file that cannot be
 *                     read, copy it aside (`<file>.damaged-<time>`): the
 *                     overwrite is irreversible, the evidence must survive it.
 *   readJsonl         rows + an honest account of what could not be read,
 *                     warned about once per file instead of silently.
 *
 * Tests: tests/atomic-write.test.js
 */

const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')

function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) }
  catch (e) { try { fs.unlinkSync(tmp) } catch { /* already gone */ } throw e }
}

/**
 * @returns {{rows: object[], badLines: number[], truncatedTail: boolean}}
 *   badLines are 1-based numbers of unparseable lines that are NOT the
 *   unterminated final line; truncatedTail is that final line.
 */
function inspectJsonl(text) {
  const s = String(text || '')
  const lines = s.split('\n')
  const endsClean = s.endsWith('\n') || s === ''
  const rows = [], badLines = []
  let truncatedTail = false
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try { rows.push(JSON.parse(line)) }
    catch {
      const isLast = i === lines.length - 1
      if (isLast && !endsClean) truncatedTail = true
      else badLines.push(i + 1)
    }
  })
  return { rows, badLines, truncatedTail }
}

/** Is this file damaged in a way an overwrite would make permanent? */
function damageOf(file, kind) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    return e.code === 'ENOENT' ? null : `unreadable (${e.code || e.message})`
  }
  if (kind === 'json') {
    if (!text.trim()) return 'empty'
    try { JSON.parse(text); return null } catch { return 'not valid JSON' }
  }
  const { badLines } = inspectJsonl(text)
  return badLines.length ? `${badLines.length} unreadable line(s): ${badLines.slice(0, 5).join(', ')}` : null
}

/**
 * Copy a damaged file aside before it is overwritten. Returns the copy's path,
 * or null when the file is absent or healthy. Never throws — preserving the
 * evidence must not itself block the write.
 */
function quarantineIfDamaged(file, kind) {
  const damage = damageOf(file, kind)
  if (!damage) return null
  const dest = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    fs.copyFileSync(file, dest)
    console.error(`[atomic-write] ${path.basename(file)} was damaged (${damage}) — kept a copy at ${path.basename(dest)} before overwriting`)
    return dest
  } catch (e) {
    console.error(`[atomic-write] ${path.basename(file)} is damaged (${damage}) and could not be copied aside: ${e.message}`)
    return null
  }
}

function writeJsonAtomic(file, value, { space = 2 } = {}) {
  quarantineIfDamaged(file, 'json')
  writeFileAtomic(file, JSON.stringify(value, null, space))
}

function rewriteJsonl(file, rows) {
  quarantineIfDamaged(file, 'jsonl')
  writeFileAtomic(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

const _warned = new Map()
/** Rows of a JSONL file; unreadable lines are reported once per file+count, not swallowed. */
function readJsonl(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return []
    console.error(`[atomic-write] ${path.basename(file)} exists but cannot be read (${e.code || e.message}) — treating as unknown, not empty`)
    throw e
  }
  const { rows, badLines, truncatedTail } = inspectJsonl(text)
  const sig = `${badLines.length}/${truncatedTail}`
  if ((badLines.length || truncatedTail) && _warned.get(file) !== sig) {
    _warned.set(file, sig)
    console.warn(`[atomic-write] ${path.basename(file)}: ${badLines.length} unreadable line(s)` +
      `${truncatedTail ? ' + an unfinished last line (dropped)' : ''} — these rows are MISSING, not absent`)
  }
  return rows
}

module.exports = { writeFileAtomic, writeJsonAtomic, rewriteJsonl, readJsonl, inspectJsonl, damageOf, quarantineIfDamaged }
