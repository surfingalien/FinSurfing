'use strict'

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const df = require('../lib/durable-files')

// Minimal emulation of the durable_files table, honouring the one property the
// module depends on: an UPDATE only lands when the stored version matches.
function fakeDb() {
  const rows = new Map()
  const calls = []
  async function query(sql, params = []) {
    calls.push(sql.trim().split(/\s+/)[0])
    if (/^\s*CREATE TABLE/i.test(sql)) return { rows: [] }
    if (/SELECT name, content/i.test(sql)) {
      return { rows: params[0].filter(n => rows.has(n)).map(n => ({ name: n, ...rows.get(n) })) }
    }
    if (/SELECT version FROM durable_files/i.test(sql)) {
      const r = rows.get(params[0]); return { rows: r ? [{ version: r.version }] : [] }
    }
    if (/^\s*INSERT INTO durable_files/i.test(sql)) {
      const [name, content, sha256, bytes, expected] = params
      const cur = rows.get(name)
      if (!cur) { rows.set(name, { content, sha256, bytes, version: 1 }); return { rows: [{ version: 1 }] } }
      if (cur.version !== expected) return { rows: [] }
      const version = cur.version + 1
      rows.set(name, { content, sha256, bytes, version })
      return { rows: [{ version }] }
    }
    throw new Error('unexpected sql: ' + sql)
  }
  return { query, rows, calls }
}

function put(db, name, text, version = 1) {
  const buf = Buffer.from(text)
  db.rows.set(name, { content: df.encode(buf), sha256: df.sha256(buf), bytes: buf.length, version })
}

let dir, files
beforeEach(() => {
  df._resetForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'))
  files = [
    { name: 'preds.jsonl', path: path.join(dir, 'preds.jsonl') },
    { name: 'lib.jsonl',   path: path.join(dir, 'lib.jsonl') },
  ]
})
afterAll(() => df._resetForTests())

describe('payload sizing', () => {
  test('tailLines keeps only whole trailing lines', () => {
    const buf = Buffer.from('aaaa\nbbbb\ncccc\n')
    expect(df.tailLines(buf, 100).toString()).toBe('aaaa\nbbbb\ncccc\n')
    expect(df.tailLines(buf, 8).toString()).toBe('cccc\n')
    expect(df.tailLines(buf, 12).toString()).toBe('bbbb\ncccc\n')   // never the partial "aa\n"
    expect(df.tailLines(buf, 10).toString()).toBe('bbbb\ncccc\n')   // a cut on a boundary keeps that line
  })

  test('an oversized file is truncated only when tail reads are safe', () => {
    const buf = Buffer.from('x'.repeat(50) + '\nlast\n')
    expect(df.payloadFor({ tailOk: true }, buf, 10)).toMatchObject({ truncated: true })
    expect(df.payloadFor({ tailOk: true }, buf, 10).payload.toString()).toBe('last\n')
    expect(df.payloadFor({}, buf, 10).skip).toMatch(/not safe to truncate/)
  })
})

describe('restoreFromDb', () => {
  test('the stored snapshot wins over the local seed', async () => {
    const db = fakeDb()
    fs.writeFileSync(files[0].path, 'seed\n')
    put(db, 'preds.jsonl', 'seed\ngrown\n', 4)
    const out = await df.restoreFromDb(db.query, files)
    expect(fs.readFileSync(files[0].path, 'utf8')).toBe('seed\ngrown\n')
    expect(out.files['preds.jsonl']).toMatchObject({ status: 'restored', version: 4 })
    expect(out.files['lib.jsonl']).toMatchObject({ status: 'absent', version: 0 })
  })

  test('a row failing its checksum is reported corrupt and the disk left alone', async () => {
    const db = fakeDb()
    fs.writeFileSync(files[0].path, 'local\n')
    put(db, 'preds.jsonl', 'stored\n')
    db.rows.get('preds.jsonl').sha256 = 'deadbeef'
    const out = await df.restoreFromDb(db.query, files)
    expect(out.files['preds.jsonl'].status).toBe('corrupt')
    expect(fs.readFileSync(files[0].path, 'utf8')).toBe('local\n')
  })
})

describe('flushing', () => {
  async function boot(db) {
    const summary = await df.restoreFromDb(db.query, files)
    df._adopt(summary, files)
  }

  test('seeds an absent row, then skips when nothing changed', async () => {
    const db = fakeDb()
    fs.writeFileSync(files[1].path, 'one\n')
    await boot(db)
    expect((await df.flushChanged({ query: db.query, files }))['lib.jsonl']).toBe('flushed')
    expect(df.decode(db.rows.get('lib.jsonl').content).toString()).toBe('one\n')
    expect((await df.flushChanged({ query: db.query, files }))['lib.jsonl']).toBe('unchanged')
  })

  test('a restored file is not re-written until it actually changes', async () => {
    const db = fakeDb()
    put(db, 'preds.jsonl', 'a\n', 2)
    await boot(db)
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('unchanged')
    fs.appendFileSync(files[0].path, 'b\n')
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('flushed')
    expect(db.rows.get('preds.jsonl').version).toBe(3)
  })

  test('a missing file never deletes the stored copy', async () => {
    const db = fakeDb()
    put(db, 'preds.jsonl', 'keep\n')
    await boot(db)
    fs.unlinkSync(files[0].path)
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('missing')
    expect(df.decode(db.rows.get('preds.jsonl').content).toString()).toBe('keep\n')
  })

  test('a version conflict adopts the newer version, then the running process wins', async () => {
    const db = fakeDb()
    put(db, 'preds.jsonl', 'a\n', 1)
    await boot(db)
    put(db, 'preds.jsonl', 'other-instance\n', 2)        // another instance wrote meanwhile
    fs.appendFileSync(files[0].path, 'mine\n')
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('conflict')
    expect(df.decode(db.rows.get('preds.jsonl').content).toString()).toBe('other-instance\n')
    fs.appendFileSync(files[0].path, 'more\n')
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('flushed')
    expect(df.decode(db.rows.get('preds.jsonl').content).toString()).toBe('a\nmine\nmore\n')
    expect(df.status().files.find(f => f.name === 'preds.jsonl').conflicts).toBe(1)
  })

  test('a corrupt row is never overwritten by the local seed', async () => {
    const db = fakeDb()
    fs.writeFileSync(files[0].path, 'seed\n')
    put(db, 'preds.jsonl', 'real history\n', 7)
    db.rows.get('preds.jsonl').sha256 = 'bad'
    await boot(db)
    fs.appendFileSync(files[0].path, 'new\n')
    expect((await df.flushChanged({ query: db.query, files }))['preds.jsonl']).toBe('skipped')
    expect(db.rows.get('preds.jsonl').version).toBe(7)
  })
})

describe('restoreSync', () => {
  test('inert without DATABASE_URL — no child process is spawned', () => {
    const exec = jest.fn()
    expect(df.restoreSync({ env: {}, exec })).toMatchObject({ enabled: false })
    expect(exec).not.toHaveBeenCalled()
    expect(df.status().enabled).toBe(false)
  })

  test('DURABLE_FILES=off disables it', () => {
    const exec = jest.fn()
    expect(df.restoreSync({ env: { DATABASE_URL: 'x', DURABLE_FILES: 'off' }, exec }).enabled).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  test('a failed restore disables flushing entirely — the seed must never overwrite history', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const exec = () => { throw new Error('connect ECONNREFUSED') }
    expect(df.restoreSync({ env: { DATABASE_URL: 'x' }, exec })).toMatchObject({ enabled: false })
    const db = fakeDb()
    fs.writeFileSync(files[0].path, 'seed\n')
    expect(await df.flushChanged({ query: db.query, files })).toEqual({})
    expect(db.calls).toEqual([])
    expect(df.startMirror()).toBe(false)
    err.mockRestore()
  })

  test('adopts the summary printed by the child (last stdout line)', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const summary = { files: Object.fromEntries(df.FILES.map(f => [f.name, { status: 'absent', version: 0, sha: null }])) }
    const exec = () => 'noise\n' + JSON.stringify(summary) + '\n'
    expect(df.restoreSync({ env: { DATABASE_URL: 'x' }, exec }).enabled).toBe(true)
    expect(df.status().files.every(f => f.flushable)).toBe(true)
    log.mockRestore()
  })
})
