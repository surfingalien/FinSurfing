// Run by tests/vite-shared-cjs.test.js in a child process: Jest cannot load ES
// modules or start Vite. Prints one JSON report on stdout.
//
// It starts Vite's dev pipeline with the repo's real vite.config.mjs, asks it
// for each SHARED_CJS file as the browser would, and evaluates the result as an
// ES module, so it checks the plugin as configured rather than a copy of it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { SHARED_CJS, cjsToEsm, sharedCjsPatterns } from '../../tools/vite/shared-cjs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const evaluate = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

// The same value from require() and from the ES module: identical source for
// functions, identical JSON for data.
const same = (a, b) => typeof a === typeof b &&
  (typeof a === 'function' ? String(a) === String(b) : JSON.stringify(a) === JSON.stringify(b))

async function devModules() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finsurf-vite-probe-'))
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.mjs'),
    logLevel: 'silent',
    cacheDir,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    const out = []
    for (const file of SHARED_CJS) {
      const abs = path.join(root, file)
      if (!fs.existsSync(abs)) { out.push({ file, present: false }); continue }
      const { code } = await server.transformRequest('/' + file)
      const ns = await evaluate(code)
      const cjs = require(abs)
      const named = Object.keys(ns).filter(k => k !== 'default').sort()
      out.push({
        file,
        present: true,
        named,
        required: Object.keys(cjs).sort(),
        defaultMatches: Object.keys(cjs).every(k => same(ns.default[k], cjs[k])),
        namedMatch: named.every(k => same(ns[k], cjs[k])),
      })
    }
    return out
  } finally {
    await server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
}

async function edgeCases() {
  const ns = await evaluate(cjsToEsm([
    "'use strict'",
    'exports.plain = 1',
    "exports['dash-name'] = 2",
    'exports.delete = 3',
    'exports.thisIsExports = this === exports',
    "exports.needsFs = () => require('fs')",
  ].join('\n'), 'lib/fixture.js'))
  let requireError = null
  try { ns.needsFs() } catch (e) { requireError = e.message }

  const reassigned = await evaluate(cjsToEsm(
    'function helper() { return 7 }\nmodule.exports = { helper }', 'lib/fixture2.js'))

  let reexportError = null
  try { cjsToEsm("module.exports = require('./other')", 'lib/fixture3.js') } catch (e) { reexportError = e.message }

  const match = id => sharedCjsPatterns(['lib/portfolio-pnl.js']).some(re => re.test(id))
  return {
    named: Object.keys(ns).filter(k => k !== 'default').sort(),
    values: { plain: ns.plain, dash: ns['dash-name'], del: ns.delete, thisIsExports: ns.thisIsExports },
    defaultKeys: Object.keys(ns.default).sort(),
    requireError,
    reassigned: { helper: reassigned.helper(), defaultHelper: reassigned.default.helper() },
    reexportError,
    patterns: {
      posix: match('/srv/app/lib/portfolio-pnl.js'),
      windows: match('C:\\app\\lib\\portfolio-pnl.js'),
      query: match('/srv/app/lib/portfolio-pnl.js?v=1'),
      otherExtension: match('/srv/app/lib/portfolio-pnl.jsx'),
      otherDir: match('/srv/app/mylib/portfolio-pnl.js'),
    },
  }
}

const report = { list: SHARED_CJS, modules: await devModules(), edge: await edgeCases() }
process.stdout.write(JSON.stringify(report))
