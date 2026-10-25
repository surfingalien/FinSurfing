'use strict'

/**
 * lib/zip-read.js — read the entries of a .zip held in memory (stored or
 * deflated), via the central directory. Enough for SEC's quarterly data sets;
 * no ZIP64, no encryption — both are refused rather than misread. Pure.
 * Tests: tests/insider-buys.test.js
 */

const zlib = require('zlib')

function findEocd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('not a zip file (no end-of-central-directory record)')
}

/** { name → Buffer } for the entries whose names pass `want` (default: all). */
function readZip(buf, want = () => true) {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  const out = {}
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory')
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + xlen + clen
    if (!want(name)) continue
    if (flags & 1) throw new Error(`${name} is encrypted`)
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + csize)
    if (method === 0) out[name] = Buffer.from(data)
    else if (method === 8) out[name] = zlib.inflateRawSync(data)
    else throw new Error(`${name}: compression method ${method} is not supported`)
  }
  return out
}

module.exports = { readZip }
