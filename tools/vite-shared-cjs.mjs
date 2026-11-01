/**
 * CommonJS modules the browser shares with the server — one implementation,
 * served to the browser as an ES module in dev AND in the production build.
 *
 * lib/portfolio-pnl.js is CommonJS (`module.exports`) because the server and
 * Jest `require()` it, and src/ imports the same file so the P&L math has one
 * source of truth. Browsers only run ES modules. `vite build` used to convert
 * it through build.commonjsOptions.include, but the dev server serves files
 * outside node_modules untouched, so `npm run dev` died on `module.exports`
 * ("module is not defined") and rendered a blank page. This plugin does the
 * conversion in both modes, so what works in dev is what ships.
 *
 * A file listed here runs in the browser: it must stay pure (no Node built-ins)
 * and must not require() anything. tests/shared-cjs.test.js fails when src/
 * imports a file from outside src/ that is not listed here, and checks that the
 * converted module exports exactly what require() returns.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

// Repo-relative paths of the CommonJS files src/ may import.
export const SHARED_CJS = ['lib/portfolio-pnl.js']

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const posix = p => p.split(path.sep).join('/')

// Export names, read by loading the file the way the server does. Safe because
// a shared file is pure by definition (it runs in the browser). The cache entry
// is dropped first so an edit in dev picks up added or removed exports.
function exportNames(file) {
  const req = createRequire(file)
  const key = req.resolve(file)
  delete req.cache[key]
  return Object.keys(req(key)).filter(n => n !== 'default' && IDENTIFIER.test(n))
}

// Wrap CommonJS source as an ES module: run it in a function scope with its own
// `module`/`exports`, then re-export each property by name plus the whole object
// as `default`. The wrapper opens on the source's first line, so line numbers in
// browser stack traces match the file on disk.
export function toEsm(code, names, label) {
  const noRequire = `function (id) { throw new Error(${JSON.stringify(
    `${label} runs in the browser and cannot require() other modules (tried `,
  )} + id + ')') }`
  return [
    `const __cjs = { exports: {} }; (function (module, exports, require) {${code}`,
    `}).call(__cjs.exports, __cjs, __cjs.exports, ${noRequire});`,
    'export default __cjs.exports;',
    ...names.map((name, i) => `const __cjs_${i} = __cjs.exports.${name}; export { __cjs_${i} as ${name} };`),
    '',
  ].join('\n')
}

export function sharedCjs(root) {
  const files = new Map(SHARED_CJS.map(rel => [posix(path.resolve(root, rel)), rel]))
  return {
    name: 'finsurf:shared-cjs',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      const rel = files.get(file)
      if (!rel) return null
      // map: null — the wrapper moves no source line, so mappings still hold.
      return { code: toEsm(code, exportNames(file), rel), map: null }
    },
  }
}
