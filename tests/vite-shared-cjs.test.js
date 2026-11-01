'use strict'
/**
 * CommonJS lib/ modules imported by the client (tools/vite/shared-cjs.mjs).
 *
 * The files stay CommonJS because Jest and the server require() them. Vite
 * serves source files to the browser as native ESM, so before the dev plugin
 * `vite` threw "module is not defined" on lib/portfolio-pnl.js, and since
 * App.jsx imports usePortfolio, the whole app was blank in dev. The production
 * build converts them through commonjsOptions.include; both read SHARED_CJS.
 *
 * The plugin and Vite are ES modules, so the checks run in a child process
 * (tests/helpers/vite-shared-cjs-probe.mjs) and come back as JSON.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PROBE = path.join(__dirname, 'helpers', 'vite-shared-cjs-probe.mjs')

let report
beforeAll(() => {
  // stderr is captured, not inherited: closing the probe's server cancels the
  // React pre-bundle that plugin-react starts, and esbuild prints
  // "✘ [ERROR] The build was canceled" for it. That is harmless (exit 0, full
  // report). If the probe really fails, execFileSync throws with the stderr in
  // its message, so nothing is hidden.
  report = JSON.parse(execFileSync(process.execPath, [PROBE], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  }))
})

// Every relative import in src/ that lands in lib/, as a repo-relative path.
function clientLibImports() {
  const found = new Map()
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(m?js|jsx)$/.test(entry.name)) continue
      const src = fs.readFileSync(full, 'utf8')
      const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])(\.[^'"]+)\1/gm
      let m
      while ((m = re.exec(src))) {
        const target = path.relative(ROOT, path.resolve(path.dirname(full), m[2])).split(path.sep).join('/')
        if (target.startsWith('lib/')) found.set(target, path.relative(ROOT, full))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return found
}

describe('shared CommonJS lib/ modules in the Vite client', () => {
  test('every lib/ file imported from src/ is in SHARED_CJS', () => {
    const imports = clientLibImports()
    expect(imports.size).toBeGreaterThan(0)
    const missing = [...imports].filter(([file]) => !report.list.includes(file))
      .map(([file, from]) => `${file} (imported by ${from})`)
    expect(missing).toEqual([])
  })

  test('the dev server serves each listed file as an ES module with the same exports as require()', () => {
    const present = report.modules.filter(m => m.present)
    expect(present.map(m => m.file)).toContain('lib/portfolio-pnl.js')
    for (const m of present) {
      expect({ file: m.file, named: m.named }).toEqual({ file: m.file, named: m.required })
      expect({ file: m.file, defaultMatches: m.defaultMatches, namedMatch: m.namedMatch })
        .toEqual({ file: m.file, defaultMatches: true, namedMatch: true })
    }
  })

  test('conversion keeps CommonJS semantics the client could rely on', () => {
    const { edge } = report
    // exports.x, quoted names and reserved words all become named exports.
    expect(edge.named).toEqual(['dash-name', 'delete', 'needsFs', 'plain', 'thisIsExports'])
    expect(edge.values).toEqual({ plain: 1, dash: 2, del: 3, thisIsExports: true })
    expect(edge.defaultKeys).toEqual(edge.named)
    // A top-level declaration named like an export does not collide with it.
    expect(edge.reassigned).toEqual({ helper: 7, defaultHelper: 7 })
    // No synchronous loader in the browser: require() fails loudly, naming the file.
    expect(edge.requireError).toMatch(/^lib\/fixture\.js: require\("fs"\) is not available/)
    expect(edge.reexportError).toMatch(/re-exports/)
  })

  test('the build include patterns match the file under either separator, and nothing else', () => {
    expect(report.edge.patterns).toEqual({
      posix: true, windows: true, query: true, otherExtension: false, otherDir: false,
    })
  })
})
