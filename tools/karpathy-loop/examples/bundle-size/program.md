# Goal
Shrink the production bundle. The score is `node tools/karpathy-loop/examples/bundle-size/measure.js`,
which builds with `npx vite build` and prints `metric: <gzipped KB of dist/assets/*.js>`. Lower is better.

# What you may change
Only `vite.config.mjs` (build options, `manualChunks`, minifier/target settings). Everything else is
reverted without being looked at — including the measuring script, the tests and this file.

# Rules
- One hypothesis per experiment, e.g. "split recharts' d3 dependencies into their own chunk".
- Do not remove or rename the `sharedCjs(ROOT)` plugin or the `/api` dev proxy — the dev server and
  `tests/shared-cjs.test.js` depend on them.
- Do not add dependencies or touch source files.
- Simpler wins: a config that is shorter at the same size is kept; a 0.05 KB gain that needs a page of
  config is not worth it.
- A discarded idea stays discarded — the recent experiments are listed below the loop state.

# Ideas not yet tried (start anywhere)
`build.target`, `build.minify` ('esbuild' vs 'terser' needs a dependency — skip), `build.cssCodeSplit`,
finer `manualChunks` (function form, by package), `build.rollupOptions.output.compact`.
