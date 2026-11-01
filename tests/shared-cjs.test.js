'use strict'
/**
 * src/ imports lib/portfolio-pnl.js, a CommonJS file the server and Jest
 * require(). tools/vite-shared-cjs.mjs serves it to the browser as an ES module
 * in dev and in the build; before it, `npm run dev` rendered a blank page
 * ("module is not defined") while `npm test` and `npm run build` stayed green.
 *
 * Pinned here:
 *  - every .js/.cjs file src/ imports from outside src/ is listed in SHARED_CJS
 *    (an unlisted one blanks the dev page, and nothing else would notice);
 *  - the converted module exports exactly what require() returns and computes
 *    the same P&L, so the browser and the server run one implementation.
 *
 * The plugin is an ES module, so it runs in a child `node` process.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const PLUGIN_URL = pathToFileURL(path.join(ROOT, 'tools', 'vite-shared-cjs.mjs')).href

// Fresh, stale and unpriced positions — every branch of enrichPosition/portfolioSummary.
const SAMPLE = [
  [{ symbol: 'AAA', shares: 10, avgCost: 150 }, { price: 180, prevClose: 175 }],
  [{ symbol: 'BBB', shares: 4, avgCost: 50 }, { price: 40, change: -1.5, stale: true }],
  [{ symbol: 'CCC', shares: 2, avgCost: 20 }, { price: 25, changePct: 4 }],
  [{ symbol: 'DDD', shares: 3, avgCost: 10 }, null],
]

const CHILD = `
import fs from 'node:fs'
import path from 'node:path'
import { SHARED_CJS, sharedCjs, toEsm } from ${JSON.stringify(PLUGIN_URL)}

const root = ${JSON.stringify(ROOT)}
const SAMPLE = ${JSON.stringify(SAMPLE)}
const plugin = sharedCjs(root)
const asUrl = code => 'data:text/javascript,' + encodeURIComponent(code)
const posix = p => p.split(path.sep).join('/')
const out = { SHARED_CJS, files: {} }

for (const rel of SHARED_CJS) {
  const id = posix(path.resolve(root, rel))
  const code = fs.readFileSync(id, 'utf8')
  const ns = await import(asUrl(plugin.transform(code, id).code))
  out.files[rel] = {
    names: Object.keys(ns).filter(k => k !== 'default').sort(),
    types: Object.fromEntries(Object.keys(ns).filter(k => k !== 'default').map(k => [k, typeof ns[k]])),
    defaultKeys: Object.keys(ns.default).sort(),
    withQuery: plugin.transform(code, id + '?v=1') !== null,
  }
  if (rel === 'lib/portfolio-pnl.js') {
    const enriched = SAMPLE.map(([pos, quote]) => ns.enrichPosition(pos, quote))
    out.pnl = { enriched, summary: ns.portfolioSummary(enriched) }
  }
}

out.unlistedUntouched = plugin.transform('module.exports = {}', posix(path.join(root, 'lib', 'not-shared.js'))) === null
try {
  await import(asUrl(toEsm("const fs = require('fs'); module.exports = { fs }", ['fs'], 'lib/x.js')))
  out.requireError = null
} catch (e) { out.requireError = e.message }

console.log(JSON.stringify(out))
`

let child
beforeAll(() => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`plugin check failed:\n${r.stderr}`)
  child = JSON.parse(r.stdout)
})

// Files outside src/ that src/ imports (static or dynamic), resolved like Vite would.
function importsOutsideSrc() {
  const found = new Map()
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(jsx?|mjs|tsx?)$/.test(e.name)) continue
      const text = fs.readFileSync(p, 'utf8')
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const base = path.resolve(path.dirname(p), m[1])
        if (base.startsWith(SRC + path.sep)) continue
        const file = [base, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js')]
          .find(f => fs.existsSync(f) && fs.statSync(f).isFile())
        if (file && /\.c?js$/.test(file)) found.set(path.relative(ROOT, file).split(path.sep).join('/'), path.relative(ROOT, p))
      }
    }
  }
  walk(SRC)
  return found
}

describe('shared CommonJS modules (tools/vite-shared-cjs.mjs)', () => {
  test('every CommonJS file src/ imports from outside src/ is converted for the browser', () => {
    const unlisted = [...importsOutsideSrc()]
      .filter(([file]) => !child.SHARED_CJS.includes(file))
      .map(([file, from]) => `${file} (imported by ${from}) — add it to SHARED_CJS in tools/vite-shared-cjs.mjs`)
    expect(unlisted).toEqual([])
  })

  test('the converted module exports exactly what require() returns', () => {
    for (const rel of child.SHARED_CJS) {
      const mod = require(path.join(ROOT, rel))
      const names = Object.keys(mod).sort()
      const got = child.files[rel]
      expect(got.names).toEqual(names)
      expect(got.defaultKeys).toEqual(names)
      expect(got.types).toEqual(Object.fromEntries(names.map(k => [k, typeof mod[k]])))
      expect(got.withQuery).toBe(true) // Vite ids can carry ?v=… / ?import
    }
  })

  test('the browser copy of portfolio-pnl computes the same P&L as the server copy', () => {
    const { enrichPosition, portfolioSummary } = require('../lib/portfolio-pnl')
    const enriched = SAMPLE.map(([pos, quote]) => enrichPosition(pos, quote))
    expect(child.pnl.enriched).toEqual(JSON.parse(JSON.stringify(enriched)))
    expect(child.pnl.summary).toEqual(portfolioSummary(enriched))
  })

  test('only listed files are rewritten; a require() in a shared file fails with a clear message', () => {
    expect(child.unlistedUntouched).toBe(true)
    expect(child.requireError).toMatch(/lib\/x\.js runs in the browser and cannot require\(\) other modules \(tried fs\)/)
  })
})
