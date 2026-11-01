/**
 * CommonJS modules under lib/ that the client imports.
 *
 * These files are shared with the server and Jest. Jest `require()`s them with
 * no Babel transform, so they have to stay CommonJS (`module.exports = {...}`).
 * Vite handles that differently in each mode:
 *   - build: @rollup/plugin-commonjs converts a file only if it matches
 *     `build.commonjsOptions.include`. Off the list, the build still succeeds,
 *     but the import namespace is empty, so every function is undefined at runtime.
 *   - dev: Vite serves source files as native ESM with no conversion, so the
 *     browser throws "module is not defined" and any view that imports the
 *     file fails to load. App.jsx imports usePortfolio, so that was the whole app.
 *
 * SHARED_CJS is the one list both modes read: `sharedCjsPatterns()` feeds
 * commonjsOptions.include, and `sharedCjsDev()` is a serve-only plugin that
 * converts the same files.
 */
import path from 'node:path'
import { initSync, parse } from 'cjs-module-lexer'
import { normalizePath } from 'vite'

// Repo-relative paths, forward slashes. Add a file here when src/ starts
// importing it; tests/vite-shared-cjs.test.js fails if one is missing.
export const SHARED_CJS = [
  'lib/portfolio-pnl.js',
  'lib/horizon-setups.js',
]

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isIdentifier = s => /^[A-Za-z_$][\w$]*$/.test(s)

// For build.commonjsOptions.include: one regex per file, accepting either path
// separator so it matches on Windows too.
export function sharedCjsPatterns(list = SHARED_CJS) {
  return list.map(p => new RegExp(
    '(?:^|[\\\\/])' + p.split('/').map(escapeRe).join('[\\\\/]') + '(?:\\?|$)'
  ))
}

initSync()

/**
 * Rewrite a CommonJS module as an ES module.
 *
 * The body runs inside a function that receives `module`, `exports` and
 * `require`, like Node's own wrapper. Top-level declarations stay local to that
 * function, so they cannot collide with the export bindings added after it.
 * The wrapper opens on line 1 without adding a line, so line numbers in stack
 * traces match the source file.
 *
 * Exports: `default` is module.exports, which is what Rollup's CommonJS plugin
 * gives the production build. The named exports are the names
 * cjs-module-lexer finds, the same detection Node uses when ESM imports a
 * CommonJS file.
 *
 * `require()` throws: there is no synchronous loader in the browser, so a
 * shared module must not depend on other modules.
 */
export function cjsToEsm(code, file) {
  const { exports: found, reexports } = parse(code)
  if (reexports.length) {
    throw new Error(`${file}: re-exports from require(${reexports.join(', ')}) cannot run in the browser`)
  }
  const names = [...new Set(found)].filter(n => n !== 'default' && n !== '__esModule')
  const M = '__sharedCjsModule'
  const tail = [
    '',
    `}).call(${M}.exports, ${M}, ${M}.exports, function require(id) {`,
    `  throw new Error(${JSON.stringify(file)} + ': require(' + JSON.stringify(id) + ') is not available in the browser')`,
    '});',
    `export default ${M}.exports;`,
    ...names.map((n, i) => `const __sharedCjsExport${i} = ${M}.exports[${JSON.stringify(n)}];`),
  ]
  if (names.length) {
    const specifiers = names.map((n, i) => `__sharedCjsExport${i} as ${isIdentifier(n) ? n : JSON.stringify(n)}`)
    tail.push(`export { ${specifiers.join(', ')} };`)
  }
  return `const ${M} = { exports: {} }; (function (module, exports, require) {${code}${tail.join('\n')}\n`
}

// Dev server only (`vite`/`npm run dev`); `vite build` uses commonjsOptions.
export function sharedCjsDev(list = SHARED_CJS) {
  let files = new Map()
  return {
    name: 'finsurf:shared-cjs-dev',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      files = new Map(list.map(p => [normalizePath(path.resolve(config.root, p)), p]))
    },
    transform(code, id) {
      const file = files.get(normalizePath(id.split('?')[0]))
      if (!file) return null
      // map: null says the code was not moved: every original line keeps its
      // number (line 1 only gains a prefix), so stack traces still point at the file.
      return { code: cjsToEsm(code, file), map: null }
    },
  }
}
