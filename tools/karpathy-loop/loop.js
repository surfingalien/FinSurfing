#!/usr/bin/env node
'use strict'
/**
 * The Karpathy loop — an autonomous experiment loop (see README.md here).
 *
 *   agent edits → scope check → commit → guard → measure ONE number → keep
 *   (advance) or discard (reset) → log to results.tsv → repeat
 *
 * Standard library only. Pure helpers are exported for tests/karpathy-loop.test.js.
 *
 *   node tools/karpathy-loop/loop.js <config.json>                 runner mode: the runner calls the agent
 *   node tools/karpathy-loop/loop.js init   <config.json>          agent-driven mode: preflight + baseline
 *   node tools/karpathy-loop/loop.js step   <config.json> "why"    one experiment on the agent's edits
 *   node tools/karpathy-loop/loop.js step   <config.json> --abandon  throw away a pending (crashed) experiment
 *   node tools/karpathy-loop/loop.js status <config.json>
 *
 * Both modes share ONE implementation of an experiment (`attempt`), so the rules
 * below hold whether the runner drives a fresh agent each time or a long-lived
 * agent session drives the runner.
 *
 * Differences from the sketch in the original write-up, each there because the
 * sketch is unsafe or wrong for a real repo:
 *  - runs only on a dedicated branch with a clean tree (it uses `git reset --hard`
 *    to discard, which would destroy uncommitted work or `main`);
 *  - the agent only EDITS — the runner commits. A change touching any path outside
 *    `editable` (the metric script, the guard, program.md, this config) is reverted
 *    unseen, which is what stops the agent "improving" the number by changing the
 *    ruler;
 *  - direction `min` or `max`; the score is a `metric:` line, not "the last line";
 *  - a crash or failing guard is not thrown away at once: the agent gets the error
 *    and up to `crashRetries` (2) fixes, amended into the SAME commit, before it is
 *    logged as a crash — a typo should not cost the idea, a broken idea should not
 *    cost the budget;
 *  - secondary metrics (`metric.<name>: <n>` lines) are logged, and one with
 *    `maxWorsePct` is a soft constraint against the ORIGINAL baseline (a creeping
 *    +5% per kept step would otherwise never trip a step-to-step check);
 *  - ties go to the simpler diff (more lines deleted than added keeps);
 *  - every `recheckEvery` kept steps HEAD is re-measured and the best is reset to
 *    that — on a noisy metric the best-of-N otherwise ratchets up on luck;
 *  - hard stops: iterations, minutes, a STOP file, N consecutive failures, SIGINT.
 *
 * It never pushes and never edits anything outside the working tree + its own log.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TSV_HEADER = ['iter', 'commit', 'metric', 'delta', 'status', 'seconds', 'secondary', 'description']
const PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'production', 'prod']
const FAILURE_STATUSES = new Set(['crash', 'noop', 'scope-violation', 'guard-fail'])

// ───────────────────────── pure helpers ─────────────────────────

const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)'
const PRIMARY_RE = new RegExp(`^\\s*metric\\s*[:=]\\s*${NUM}\\s*$`, 'i')
const SECONDARY_RE = new RegExp(`^\\s*metric\\.([A-Za-z_][\\w-]*)\\s*[:=]\\s*${NUM}\\s*$`, 'i')

/** The score from a command's stdout: the LAST line `metric: <number>`. null if none. */
function parseMetric(stdout) {
  return parseMetrics(stdout).primary
}

/** `{primary, secondary}` — `metric: 1.5` and any number of `metric.<name>: 2` lines. */
function parseMetrics(stdout) {
  let primary = null
  const secondary = {}
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.match(SECONDARY_RE)
    if (s) { secondary[s[1]] = Number(s[2]); continue }
    const m = line.match(PRIMARY_RE)
    if (m) primary = Number(m[1])
  }
  return { primary: Number.isFinite(primary) ? primary : null, secondary }
}

/** Signed improvement: positive = better, whichever direction is being optimised. */
function improvement(direction, best, candidate) {
  return direction === 'max' ? candidate - best : best - candidate
}

/**
 * keep / discard decision.
 *  - improves by more than `minImprovement`  → keep
 *  - within `tolerance` of best (a tie)      → keep only if the diff DELETES more
 *    than it adds (simpler, same result)
 *  - otherwise                               → discard
 */
function decide({ direction, best, candidate, minImprovement = 0, tolerance = 0, added = 0, deleted = 0 }) {
  const gain = improvement(direction, best, candidate)
  if (gain > minImprovement && gain > tolerance) return { keep: true, reason: 'improved', gain }
  if (Math.abs(gain) <= tolerance && deleted > added) return { keep: true, reason: 'simpler', gain }
  return { keep: false, reason: gain < 0 ? 'worse' : 'no-gain', gain }
}

/**
 * First secondary metric that breaks its `maxWorsePct` limit against the ORIGINAL
 * baseline, or null. A limited metric the command stopped printing is a problem too
 * (a constraint that silently stops being checked is no constraint).
 */
function secondaryProblem(specs, baseline, candidate) {
  for (const [name, spec] of Object.entries(specs || {})) {
    if (spec.maxWorsePct == null) continue
    const b = baseline && baseline[name]
    const v = candidate && candidate[name]
    if (v == null) return `${name} not reported`
    if (b == null) continue
    const worse = spec.direction === 'max' ? b - v : v - b
    if (worse > Math.abs(b) * spec.maxWorsePct / 100) {
      return `${name} ${v} vs baseline ${b} exceeds the ${spec.maxWorsePct}% limit`
    }
  }
  return null
}

function toPosix(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, '') }

/** Is `file` covered by an `editable` entry (exact file, or a directory prefix ending in /)? */
function inScope(file, editable) {
  const f = toPosix(file)
  return editable.some(e => {
    const x = toPosix(e)
    return x.endsWith('/') ? f.startsWith(x) : f === x
  })
}

/** Files in `changed` the agent was not allowed to touch. */
function scopeViolations(changed, editable) {
  return changed.filter(f => !inScope(f, editable))
}

/** Validate + default a config object. Throws a plain Error naming the problem. */
function normalizeConfig(raw, baseDir = process.cwd()) {
  const c = { ...raw }
  const need = (k) => { if (c[k] == null || c[k] === '') throw new Error(`config: "${k}" is required`) }
  need('program'); need('editable')
  if (!c.metric || !c.metric.command) throw new Error('config: "metric.command" is required')
  if (!Array.isArray(c.editable) || c.editable.length === 0) throw new Error('config: "editable" must list at least one file')
  if (c.editable.some(e => /^(\.\/)?\.?\/?$|^\.\.|^\//.test(String(e)) || String(e) === '.')) {
    throw new Error('config: "editable" entries must be repo-relative files or directories (ending in /), never "." or absolute')
  }
  const direction = c.metric.direction || 'min'
  if (direction !== 'min' && direction !== 'max') throw new Error('config: metric.direction must be "min" or "max"')
  const secondary = {}
  for (const [name, spec] of Object.entries(c.secondary || {})) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) throw new Error(`config: secondary metric name "${name}" must be a word`)
    const d = (spec && spec.direction) || 'min'
    if (d !== 'min' && d !== 'max') throw new Error(`config: secondary "${name}" direction must be "min" or "max"`)
    if (spec && spec.maxWorsePct != null && !(spec.maxWorsePct >= 0)) throw new Error(`config: secondary "${name}" maxWorsePct must be >= 0`)
    secondary[name] = { direction: d, maxWorsePct: spec && spec.maxWorsePct != null ? spec.maxWorsePct : null }
  }
  return {
    program: c.program,
    agent: c.agent || null,          // required for runner mode only (checked in run())
    editable: c.editable.map(toPosix),
    metric: { command: c.metric.command, direction, timeoutSec: c.metric.timeoutSec || 300, tolerance: c.metric.tolerance || 0, minImprovement: c.metric.minImprovement || 0 },
    secondary,
    guard: c.guard ? { command: c.guard.command || c.guard, timeoutSec: c.guard.timeoutSec || 600 } : null,
    agentTimeoutSec: c.agentTimeoutSec || 900,
    maxIterations: c.maxIterations || 20,
    maxMinutes: c.maxMinutes || 120,
    maxConsecutiveFailures: c.maxConsecutiveFailures || 5,
    crashRetries: c.crashRetries == null ? 2 : Math.max(0, Math.floor(c.crashRetries)),
    recheckEvery: c.recheckEvery == null ? 5 : c.recheckEvery,
    stateDir: c.stateDir || '.karpathy-loop',
    allowBranch: !!c.allowBranch,
    baseDir,
  }
}

function tsvRow(fields) {
  return fields.map(v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ')).join('\t')
}

function formatSecondary(sec) {
  return Object.entries(sec || {}).map(([k, v]) => `${k}=${v}`).join(' ')
}

const tail = (text, n = 12) => String(text || '').trim().split('\n').slice(-n).join('\n').slice(-1500)

// ───────────────────────── git + process plumbing ─────────────────────────

function sh(cmd, { cwd, input, timeoutSec, env } = {}) {
  const r = spawnSync(cmd, {
    cwd, input, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSec ? timeoutSec * 1000 : undefined,
    env: { ...process.env, ...env },
  })
  return {
    code: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM',
    error: r.error ? String(r.error.message || r.error) : null,
  }
}

function makeGit(cwd) {
  const git = (args) => sh(`git ${args}`, { cwd })
  const ident = '-c user.name="karpathy-loop" -c user.email="karpathy-loop@localhost"'
  return {
    run: git,
    branch: () => git('rev-parse --abbrev-ref HEAD').stdout.trim(),
    head: () => git('rev-parse --short HEAD').stdout.trim(),
    // untracked files that are NOT ignored count, so a new file the agent creates is seen
    changed: () => git('status --porcelain --untracked-files=all').stdout
      .split('\n').filter(Boolean).map(l => {
        const p = l.slice(3)
        return toPosix(p.includes(' -> ') ? p.split(' -> ')[1] : p.replace(/^"|"$/g, ''))
      }),
    isClean: () => git('status --porcelain').stdout.trim() === '',
    numstat: (ref) => {
      let added = 0, deleted = 0
      for (const l of git(`diff --numstat ${ref}`).stdout.split('\n').filter(Boolean)) {
        const [a, d] = l.split('\t')
        added += Number(a) || 0; deleted += Number(d) || 0
      }
      return { added, deleted }
    },
    // Safe only because the loop starts from a clean tree on a dedicated branch.
    resetTo: (ref) => { git(`reset --hard ${ref}`); git('clean -fd') },
    // `amend` folds a fix into the experiment's own commit — one experiment, one commit.
    commitAll: (msg, { amend = false } = {}) => {
      git('add -A')
      return amend
        ? git(`${ident} commit -q --amend --no-edit --no-gpg-sign`)
        : git(`${ident} commit -q --no-gpg-sign -m ${JSON.stringify(msg)}`)
    },
  }
}

// ───────────────────────── session: shared by both modes ─────────────────────────

function openSession(rawConfig, log = console.log) {
  const cfg = normalizeConfig(rawConfig, rawConfig.baseDir)
  const cwd = cfg.baseDir
  const g = makeGit(cwd)
  const stateDir = path.join(cwd, cfg.stateDir)
  const paths = {
    stateDir, results: path.join(stateDir, 'results.tsv'), state: path.join(stateDir, 'state.json'),
    description: path.join(stateDir, 'description.txt'), stop: path.join(stateDir, 'STOP'),
  }
  const append = (row) => fs.appendFileSync(paths.results, tsvRow(TSV_HEADER.map(k => row[k])) + '\n')
  const measure = () => {
    const r = sh(cfg.metric.command, { cwd, timeoutSec: cfg.metric.timeoutSec })
    if (r.timedOut) return { ok: false, why: 'metric timed out' }
    if (r.code !== 0) return { ok: false, why: `metric exited ${r.code}: ${tail(r.stderr || r.stdout, 4)}` }
    const { primary, secondary } = parseMetrics(r.stdout)
    if (primary == null) return { ok: false, why: 'no "metric: <number>" line in output' }
    return { ok: true, value: primary, secondary }
  }
  const runGuard = () => (cfg.guard ? sh(cfg.guard.command, { cwd, timeoutSec: cfg.guard.timeoutSec }) : { code: 0, stdout: '', stderr: '' })
  return { cfg, cwd, g, paths, append, measure, runGuard, log }
}

const loadState = (ctx) => {
  if (!fs.existsSync(ctx.paths.state)) throw new Error('no loop state — run `init` first')
  return JSON.parse(fs.readFileSync(ctx.paths.state, 'utf8'))
}
const saveState = (ctx, state) => fs.writeFileSync(ctx.paths.state, JSON.stringify(state, null, 1))

/** Preflight + baseline. Throws on anything that would make the loop unsafe or meaningless. */
function init(ctx, now = () => Date.now()) {
  const { cfg, cwd, g, paths } = ctx
  const branch = g.branch()
  if (!branch || branch === 'HEAD') throw new Error('refusing to run on a detached HEAD — create a branch for the loop')
  if (!cfg.allowBranch && PROTECTED_BRANCHES.includes(branch)) {
    throw new Error(`refusing to run on "${branch}": the loop resets with --hard. Create a dedicated branch (git switch -c loop/<name>).`)
  }
  // The log dir must be invisible to git, or its own files would read as agent edits.
  const excludePath = g.run('rev-parse --git-path info/exclude').stdout.trim()
  if (excludePath && g.run(`check-ignore -q ${cfg.stateDir}/results.tsv`).code !== 0) {
    const abs = path.resolve(cwd, excludePath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.appendFileSync(abs, `\n${cfg.stateDir}/\n`)
  }
  if (!g.isClean()) throw new Error('refusing to run with uncommitted changes — commit or stash first (the loop resets with --hard)')
  if (!fs.existsSync(path.join(cwd, cfg.program))) throw new Error(`program file not found: ${cfg.program}`)
  if (inScope(cfg.program, cfg.editable)) throw new Error('program file must not be editable by the agent')
  fs.mkdirSync(paths.stateDir, { recursive: true })
  try { fs.unlinkSync(paths.stop) } catch { /* none */ }
  // A results file from an older version of this tool has different columns — keep it, start fresh.
  if (fs.existsSync(paths.results)) {
    const first = fs.readFileSync(paths.results, 'utf8').split('\n')[0]
    if (first !== TSV_HEADER.join('\t')) fs.renameSync(paths.results, paths.results.replace(/\.tsv$/, `.${Date.now()}.tsv`))
  }
  if (!fs.existsSync(paths.results)) fs.writeFileSync(paths.results, TSV_HEADER.join('\t') + '\n')

  const base = ctx.measure()
  if (!base.ok) throw new Error(`baseline measurement failed: ${base.why}`)
  const gr = ctx.runGuard()
  if (gr.code !== 0) throw new Error('guard fails on the unmodified baseline — fix that first, or every experiment would be discarded')
  for (const [name, spec] of Object.entries(cfg.secondary)) {
    if (spec.maxWorsePct != null && base.secondary[name] == null) {
      throw new Error(`secondary metric "${name}" has a limit but the baseline did not print "metric.${name}: <number>"`)
    }
  }
  const state = {
    branch, baseline: base.value, baselineSecondary: base.secondary, best: base.value,
    iter: 0, kept: 0, startedAt: now(), keptSinceRecheck: 0, failStreak: 0, pending: null, history: [],
  }
  ctx.append({ iter: 0, commit: g.head(), metric: base.value, delta: 0, status: 'baseline', seconds: 0, secondary: formatSecondary(base.secondary), description: 'baseline' })
  saveState(ctx, state)
  ctx.log(`baseline ${base.value} on ${branch}@${g.head()} (${cfg.metric.direction === 'max' ? 'higher' : 'lower'} is better)`)
  return state
}

/** Why the loop should stop before the next experiment, or null. */
function stopReason(ctx, state, now = () => Date.now(), stopSignal = { stop: false }) {
  const { cfg } = ctx
  if (stopSignal.stop) return 'interrupted'
  if (fs.existsSync(ctx.paths.stop)) return 'STOP file'
  if (state.iter >= cfg.maxIterations) return `maxIterations (${cfg.maxIterations})`
  if ((now() - state.startedAt) / 60000 >= cfg.maxMinutes) return `maxMinutes (${cfg.maxMinutes})`
  if (state.failStreak >= cfg.maxConsecutiveFailures) return `${state.failStreak} consecutive failures`
  return null
}

/**
 * ONE experiment on whatever the agent has changed in the working tree.
 * Returns {status, ...}: a final status (keep, discard, constraint-fail, crash, noop,
 * scope-violation, guard-fail) or `retry` — the experiment crashed, is still committed,
 * and the agent may fix it and call again (the same pending experiment, up to crashRetries).
 */
function attempt(ctx, state, description, now = () => Date.now()) {
  const { cfg, g } = ctx
  const pending = state.pending
  const parent = pending ? pending.parent : g.run('rev-parse HEAD').stdout.trim()
  const iter = pending ? pending.iter : state.iter + 1
  const t0 = pending ? pending.t0 : now()
  const fixes = pending ? pending.fixes : 0
  const desc = pending ? pending.description : (description || `experiment ${iter}`)
  if (!pending) state.iter = iter

  const finish = (status, metric, text, secondary) => {
    const row = {
      iter, commit: g.head(), metric: metric == null ? '' : metric,
      delta: metric == null ? '' : +improvement(cfg.metric.direction, state.best, metric).toFixed(6),
      status, seconds: Math.round((now() - t0) / 1000),
      secondary: formatSecondary(secondary),
      description: fixes ? `${text} (after ${fixes} fix${fixes > 1 ? 'es' : ''})` : text,
    }
    ctx.append(row)
    state.pending = null
    state.failStreak = FAILURE_STATUSES.has(status) ? state.failStreak + 1 : 0
    state.history = [...state.history, { iter, status, metric: row.metric, description: row.description }].slice(-30)
    ctx.log(`#${iter} ${status}${metric == null ? '' : ' ' + metric} — ${row.description}`)
    saveState(ctx, state)
    return { status, iter, metric, description: row.description, best: state.best, stop: stopReason(ctx, state, now) }
  }
  const failed = (status, why) => {
    if (fixes < cfg.crashRetries) {
      state.pending = { parent, iter, t0, fixes: fixes + 1, description: desc, lastStatus: status, lastError: why }
      saveState(ctx, state)
      ctx.log(`#${iter} ${status} — fix ${fixes + 1}/${cfg.crashRetries} allowed: ${why.split('\n')[0]}`)
      return { status: 'retry', iter, failure: status, error: why, fixesLeft: cfg.crashRetries - fixes, best: state.best }
    }
    g.resetTo(parent)
    return finish(status, null, `${desc} (${why.split('\n')[0].slice(0, 160)})`)
  }

  // 1. scope: only editable files may change
  const changed = g.changed()
  if (changed.length === 0) {
    if (pending) { g.resetTo(parent); return finish(pending.lastStatus, null, `${desc} (fix changed nothing: ${pending.lastError.split('\n')[0].slice(0, 120)})`) }
    return finish('noop', null, desc)
  }
  const bad = scopeViolations(changed, cfg.editable)
  if (bad.length) { g.resetTo(parent); return finish('scope-violation', null, `touched ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`) }

  // 2. commit it (the runner owns history); a fix folds into the same commit
  const cm = g.commitAll(`experiment ${iter}: ${desc}`, { amend: !!pending })
  if (cm.code !== 0) { g.resetTo(parent); return finish('crash', null, `commit failed: ${tail(cm.stderr, 2)}`) }
  const { added, deleted } = g.numstat(`${parent} HEAD`)

  // 3. guard (e.g. tests must still pass)
  const gr = ctx.runGuard()
  if (gr.code !== 0) return failed('guard-fail', `guard failed:\n${tail(gr.stderr || gr.stdout)}`)

  // 4. measure
  const m = ctx.measure()
  if (!m.ok) return failed('crash', m.why)

  // 5. soft constraints on secondary metrics (against the ORIGINAL baseline)
  const sp = secondaryProblem(cfg.secondary, state.baselineSecondary, m.secondary)
  if (sp) { g.resetTo(parent); return finish('constraint-fail', m.value, `${desc} (${sp})`, m.secondary) }

  // 6. keep or discard
  const d = decide({ direction: cfg.metric.direction, best: state.best, candidate: m.value, minImprovement: cfg.metric.minImprovement, tolerance: cfg.metric.tolerance, added, deleted })
  let result
  if (d.keep) {
    result = finish('keep', m.value, d.reason === 'simpler' ? `${desc} (simpler, same score)` : desc, m.secondary)
    if (d.reason !== 'simpler') state.best = m.value
    result.best = state.best
    state.kept++; state.keptSinceRecheck++
  } else {
    result = finish('discard', m.value, desc, m.secondary)
    g.resetTo(parent)
  }

  // 7. noise guard: re-measure HEAD; best must not ratchet on luck
  if (cfg.recheckEvery > 0 && state.keptSinceRecheck >= cfg.recheckEvery) {
    const rc = ctx.measure()
    if (rc.ok) {
      ctx.append({ iter, commit: g.head(), metric: rc.value, delta: +improvement(cfg.metric.direction, state.best, rc.value).toFixed(6), status: 'recheck', seconds: 0, secondary: formatSecondary(rc.secondary), description: `re-measured HEAD (best was ${state.best})` })
      ctx.log(`recheck HEAD ${rc.value} (best was ${state.best})`)
      state.best = rc.value
      result.best = rc.value
    }
    state.keptSinceRecheck = 0
  }
  saveState(ctx, state)
  return result
}

/** Throw away a pending (crashed, committed) experiment and log it. */
function abandon(ctx, state, now = () => Date.now()) {
  const p = state.pending
  if (!p) throw new Error('nothing pending to abandon')
  ctx.g.resetTo(p.parent)
  const row = { iter: p.iter, commit: ctx.g.head(), metric: '', delta: '', status: p.lastStatus, seconds: Math.round((now() - p.t0) / 1000), secondary: '', description: `${p.description} (abandoned: ${p.lastError.split('\n')[0].slice(0, 120)})` }
  ctx.append(row)
  state.pending = null
  state.failStreak += 1
  state.history = [...state.history, { iter: p.iter, status: p.lastStatus, metric: '', description: row.description }].slice(-30)
  saveState(ctx, state)
  return { status: p.lastStatus, iter: p.iter, abandoned: true, best: state.best, stop: stopReason(ctx, state, now) }
}

// ───────────────────────── runner mode ─────────────────────────

function buildPrompt(cfg, iter, programText, history, best, baseline) {
  const recent = history.slice(-12).map(h => `  #${h.iter} ${h.status} ${h.metric === '' || h.metric == null ? '-' : h.metric}  ${h.description}`).join('\n') || '  (none yet)'
  const sec = Object.entries(cfg.secondary).filter(([, s]) => s.maxWorsePct != null)
    .map(([n, s]) => `${n} (${s.direction === 'max' ? 'higher' : 'lower'} is better, may not be more than ${s.maxWorsePct}% worse than the baseline)`).join('; ')
  return [
    programText.trim(),
    '',
    '---',
    `# Loop state (iteration ${iter})`,
    `Metric: ${cfg.metric.direction === 'max' ? 'HIGHER' : 'LOWER'} is better. Original baseline: ${baseline}. Current best: ${best}.`,
    sec ? `Constraints: ${sec}.` : '',
    `You may edit ONLY: ${cfg.editable.join(', ')}. Anything else is reverted unseen.`,
    'Make exactly ONE targeted change (one hypothesis). Do NOT run git commit/reset — the runner commits, measures, and keeps or discards.',
    `Before you finish, write a one-line description of what you changed and why to ${cfg.stateDir}/description.txt.`,
    'Recent experiments (do not repeat a discarded idea):',
    recent,
  ].filter(l => l !== '').join('\n')
}

function buildFixPrompt(cfg, iter, failure, error, fixesLeft) {
  return [
    `Your change for experiment ${iter} is committed but ${failure === 'guard-fail' ? 'the guard (tests) failed' : 'the metric run failed'}.`,
    `Error output:\n${error}`,
    '',
    `If this is a small mistake (typo, missing import, wrong name), fix it in place — ${fixesLeft} fix${fixesLeft > 1 ? 'es' : ''} left.`,
    'If the idea itself is broken, change nothing: the experiment will be discarded and logged as a crash.',
    `You may edit ONLY: ${cfg.editable.join(', ')}. Do NOT run git commands.`,
  ].join('\n')
}

function run(rawConfig, { log = console.log, now = () => Date.now(), stopSignal = { stop: false } } = {}) {
  const ctx = openSession(rawConfig, log)
  const { cfg, cwd, paths } = ctx
  if (!cfg.agent) throw new Error('config: "agent" is required in runner mode (or use `init`/`step` and drive it from an agent session)')
  const programText = fs.existsSync(path.join(cwd, cfg.program)) ? fs.readFileSync(path.join(cwd, cfg.program), 'utf8') : ''
  const state = init(ctx, now)
  const callAgent = (prompt, iter, fixNo) => {
    try { fs.unlinkSync(paths.description) } catch { /* none */ }
    const r = sh(cfg.agent, { cwd, input: prompt, timeoutSec: cfg.agentTimeoutSec, env: { KARPATHY_ITERATION: String(iter), KARPATHY_ATTEMPT: String(fixNo) } })
    const described = fs.existsSync(paths.description) ? fs.readFileSync(paths.description, 'utf8').trim().split('\n')[0].slice(0, 200) : ''
    return { r, described }
  }
  const out = { iterations: 0, kept: 0, history: [], stoppedBecause: null }
  let sig = stopReason(ctx, state, now, stopSignal)

  while (!sig) {
    const iter = state.iter + 1
    const parent = ctx.g.run('rev-parse HEAD').stdout.trim()
    let { r, described } = callAgent(buildPrompt(cfg, iter, programText, state.history, state.best, state.baseline), iter, 0)
    let res
    if (r.timedOut || r.error) {
      ctx.g.resetTo(parent)
      state.iter = iter
      const row = { iter, commit: ctx.g.head(), metric: '', delta: '', status: 'crash', seconds: 0, secondary: '', description: `agent ${r.timedOut ? 'timed out' : 'failed'}: ${r.error || ''}`.trim() }
      ctx.append(row); state.failStreak++; state.history.push({ iter, status: 'crash', metric: '', description: row.description }); saveState(ctx, state)
      ctx.log(`#${iter} crash — ${row.description}`)
      res = { status: 'crash', iter, description: row.description }
    } else {
      res = attempt(ctx, state, described, now)
      while (res.status === 'retry') {
        const fix = callAgent(buildFixPrompt(cfg, iter, res.failure, res.error, res.fixesLeft), iter, state.pending.fixes)
        res = fix.r.timedOut || fix.r.error ? abandon(ctx, state, now) : attempt(ctx, state, '', now)
      }
    }
    out.history.push(res)
    sig = stopReason(ctx, state, now, stopSignal)
  }
  out.iterations = state.iter
  out.kept = state.kept
  out.stoppedBecause = sig
  out.baseline = state.baseline
  out.best = state.best
  out.improvementVsBaseline = +improvement(cfg.metric.direction, state.baseline, state.best).toFixed(6)
  out.branch = state.branch
  out.head = ctx.g.head()
  ctx.log(`done: ${sig}. ${out.kept} kept of ${out.iterations}. baseline ${state.baseline} → ${state.best} (${out.improvementVsBaseline >= 0 ? '+' : ''}${out.improvementVsBaseline} better). Log: ${path.relative(cwd, paths.results)}`)
  return out
}

// ───────────────────────── agent-driven mode (CLI) ─────────────────────────

function loadConfig(configPath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'))
  raw.baseDir = path.resolve(process.cwd(), raw.baseDir || '.')
  return raw
}

/** `init` / `step` / `status` for a long-lived agent session; each call is its own process. */
function agentCommand(sub, rawConfig, args, { log = () => {} } = {}) {
  const ctx = openSession(rawConfig, log)
  if (sub === 'init') {
    const s = init(ctx)
    return { ok: true, baseline: s.baseline, branch: s.branch, editable: ctx.cfg.editable, direction: ctx.cfg.metric.direction, maxIterations: ctx.cfg.maxIterations }
  }
  const state = loadState(ctx)
  const here = ctx.g.branch()
  if (here !== state.branch) throw new Error(`branch changed from "${state.branch}" to "${here}" — the loop state belongs to the first`)
  if (sub === 'status') {
    return { ok: true, iter: state.iter, kept: state.kept, baseline: state.baseline, best: state.best, pending: state.pending ? { iter: state.pending.iter, fixesUsed: state.pending.fixes, error: state.pending.lastError } : null, stop: stopReason(ctx, state), recent: state.history.slice(-10) }
  }
  if (sub === 'step') {
    if (args.includes('--abandon')) return { ok: true, ...abandon(ctx, state) }
    const stop = stopReason(ctx, state)
    if (stop && !state.pending) return { ok: false, stop, error: `loop is finished: ${stop}` }
    const description = args.filter(a => !a.startsWith('--')).join(' ').trim()
    return { ok: true, ...attempt(ctx, state, description) }
  }
  throw new Error(`unknown command "${sub}"`)
}

function main(argv) {
  const sub = ['init', 'step', 'status'].includes(argv[2]) ? argv[2] : null
  const configPath = sub ? argv[3] : argv[2]
  if (!configPath || /^(-h|--help)$/.test(configPath)) {
    console.log('usage: node tools/karpathy-loop/loop.js [init|step|status] <config.json> [description|--abandon]   (see tools/karpathy-loop/README.md)')
    return configPath ? 0 : 1
  }
  const raw = loadConfig(configPath)
  try {
    if (sub) { console.log(JSON.stringify(agentCommand(sub, raw, argv.slice(4), { log: (m) => console.error(m) }), null, 1)); return 0 }
    const stopSignal = { stop: false }
    process.on('SIGINT', () => { console.log('\nSIGINT — finishing this experiment, then stopping'); stopSignal.stop = true })
    run(raw, { stopSignal })
    return 0
  } catch (e) { console.error(`karpathy-loop: ${e.message}`); return 2 }
}

module.exports = {
  parseMetric, parseMetrics, improvement, decide, secondaryProblem, inScope, scopeViolations, normalizeConfig, tsvRow,
  buildPrompt, buildFixPrompt, openSession, init, attempt, abandon, stopReason, loadState, agentCommand, run,
  TSV_HEADER, PROTECTED_BRANCHES,
}
if (require.main === module) process.exit(main(process.argv))
