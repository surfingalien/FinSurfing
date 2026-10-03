'use strict'
/**
 * Crash-safe store writes, and "could not read" is never "nothing there".
 * The stores used to be rewritten in place; a crash mid-write truncated them,
 * readers skipped what they could not parse, and the next rewrite (and the
 * durable-files mirror) made the loss permanent.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const atomic = require('../lib/atomic-write')

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const quiet = () => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
}
afterEach(() => jest.restoreAllMocks())

describe('writeFileAtomic', () => {
  test('writes the bytes and leaves no temp file behind', () => {
    const f = path.join(dir, 'sub', 'a.json')
    atomic.writeFileAtomic(f, '{"x":1}')
    atomic.writeFileAtomic(f, '{"x":2}')
    expect(fs.readFileSync(f, 'utf8')).toBe('{"x":2}')
    expect(fs.readdirSync(path.dirname(f))).toEqual(['a.json'])
  })

  test('a failed rename removes its temp file and keeps the old content', () => {
    const f = path.join(dir, 'a.json')
    fs.writeFileSync(f, 'old')
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EXDEV') })
    expect(() => atomic.writeFileAtomic(f, 'new')).toThrow('EXDEV')
    spy.mockRestore()
    expect(fs.readFileSync(f, 'utf8')).toBe('old')
    expect(fs.readdirSync(dir)).toEqual(['a.json'])
  })
})

describe('inspectJsonl — an unfinished append is not corruption', () => {
  test('a cut-off final line is a truncated tail, not a bad line', () => {
    const r = atomic.inspectJsonl('{"a":1}\n{"a":2}\n{"a":')
    expect(r.rows).toEqual([{ a: 1 }, { a: 2 }])
    expect(r.truncatedTail).toBe(true)
    expect(r.badLines).toEqual([])
  })
  test('an unreadable line in the middle is reported by number', () => {
    const r = atomic.inspectJsonl('{"a":1}\nGARBAGE\n{"a":3}\n')
    expect(r.rows).toEqual([{ a: 1 }, { a: 3 }])
    expect(r.badLines).toEqual([2])
    expect(r.truncatedTail).toBe(false)
  })
})

describe('overwriting a damaged file keeps the evidence', () => {
  test('rewriteJsonl copies a damaged file aside before replacing it', () => {
    quiet()
    const f = path.join(dir, 'log.jsonl')
    fs.writeFileSync(f, '{"id":1}\nGARBAGE\n{"id":3}\n')
    atomic.rewriteJsonl(f, [{ id: 1 }, { id: 3 }, { id: 4 }])
    const copies = fs.readdirSync(dir).filter(n => n.includes('.damaged-'))
    expect(copies).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, copies[0]), 'utf8')).toContain('GARBAGE')
    expect(fs.readFileSync(f, 'utf8')).toBe('{"id":1}\n{"id":3}\n{"id":4}\n')
  })

  test('a healthy file, or an unfinished last line, is overwritten without a copy', () => {
    const f = path.join(dir, 'log.jsonl')
    fs.writeFileSync(f, '{"id":1}\n{"id":')
    atomic.rewriteJsonl(f, [{ id: 1 }])
    expect(fs.readdirSync(dir)).toEqual(['log.jsonl'])
  })

  test('writeJsonAtomic copies an unparseable JSON file aside', () => {
    quiet()
    const f = path.join(dir, 'book.json')
    fs.writeFileSync(f, '{"cash": 512')
    atomic.writeJsonAtomic(f, { cash: 100000 })
    expect(fs.readdirSync(dir).some(n => n.startsWith('book.json.damaged-'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ cash: 100000 })
  })
})

describe('readJsonl says what it could not read', () => {
  test('rows come back, and the missing ones are announced once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const f = path.join(dir, 'x.jsonl')
    fs.writeFileSync(f, '{"a":1}\nnope\n{"a":2}\n')
    expect(atomic.readJsonl(f)).toEqual([{ a: 1 }, { a: 2 }])
    atomic.readJsonl(f)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/MISSING, not absent/)
  })
  test('an absent file is legitimately empty and silent', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect(atomic.readJsonl(path.join(dir, 'none.jsonl'))).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

test('paper book: an unreadable book is never silently replaced by a fresh $100k one', () => {
  quiet()
  const pb = require('../lib/paper-broker')
  const f = path.join(dir, 'paper-portfolio.json')
  fs.writeFileSync(f, '{"cash": 73000, "positions": {"NVDA": {"sh')
  const loaded = pb.loadPortfolio(f)                // unreadable → default book …
  pb.savePortfolio(loaded, f)                       // … whose save used to erase the real one
  const copy = fs.readdirSync(dir).find(n => n.startsWith('paper-portfolio.json.damaged-'))
  expect(copy).toBeDefined()
  expect(fs.readFileSync(path.join(dir, copy), 'utf8')).toContain('73000')
})

describe('durable-files never mirrors a damaged file over the stored copy', () => {
  const { checkPayload } = require('../lib/durable-files')
  test('invalid JSON and empty JSON are refused', () => {
    expect(checkPayload({ name: 'a.json' }, Buffer.from('{"x":')).skip).toMatch(/not valid JSON/)
    expect(checkPayload({ name: 'a.json' }, Buffer.alloc(0)).skip).toMatch(/empty/)
    expect(checkPayload({ name: 'a.json' }, Buffer.from('{"x":1}')).buf.toString()).toBe('{"x":1}')
  })
  test('a JSONL file with a corrupt middle line is refused', () => {
    expect(checkPayload({ name: 'p.jsonl' }, Buffer.from('{"a":1}\nbad\n{"a":2}\n')).skip).toMatch(/1 unreadable line/)
  })
  test('an unfinished final line is trimmed, not refused', () => {
    const r = checkPayload({ name: 'p.jsonl' }, Buffer.from('{"a":1}\n{"a":2}\n{"a"'))
    expect(r.skip).toBeUndefined()
    expect(r.trimmedTail).toBe(true)
    expect(r.buf.toString()).toBe('{"a":1}\n{"a":2}\n')
  })
})
