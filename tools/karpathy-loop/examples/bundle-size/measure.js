#!/usr/bin/env node
'use strict'
/**
 * The ruler for the bundle-size example: build, then print
 *   metric: <total gzipped KB of dist/assets/*.js>
 * Gzipped, because that is what the browser downloads; JS only, because the
 * loop is allowed to touch the Vite config, not the CSS.
 *
 *   node measure.js              build, then measure
 *   node measure.js --no-build   measure an existing dist/ (used by the tests)
 *   DIST_DIR=…                   measure another directory
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawnSync } = require('child_process')

function gzippedKb(dir) {
  const assets = path.join(dir, 'assets')
  if (!fs.existsSync(assets)) throw new Error(`no ${assets} — did the build produce output?`)
  let bytes = 0
  for (const f of fs.readdirSync(assets)) {
    if (!f.endsWith('.js')) continue
    bytes += zlib.gzipSync(fs.readFileSync(path.join(assets, f)), { level: 9 }).length
  }
  return +(bytes / 1024).toFixed(2)
}

if (require.main === module) {
  const dir = path.resolve(process.env.DIST_DIR || 'dist')
  if (!process.argv.includes('--no-build')) {
    fs.rmSync(dir, { recursive: true, force: true })
    const b = spawnSync('npx', ['vite', 'build'], { stdio: ['ignore', process.stderr, process.stderr] })
    if (b.status !== 0) { console.error('vite build failed'); process.exit(1) }
  }
  console.log(`metric: ${gzippedKb(dir)}`)
}

module.exports = { gzippedKb }
