#!/usr/bin/env node
'use strict'
/**
 * The Karpathy loop — an autonomous experiment loop (see README.md here).
 *
 *   agent edits → commit → guard → measure ONE number → keep (advance) or
 *   discard (reset) → log to results.tsv → repeat
 *
 * Standard library only. Pure helpers are exported for tests/karpathy-loop.test.js;
 * `node tools/karpathy-loop/loop.js <config.json>` runs the loop.
 *
 * Differences from the sketch in the original write-up, each there because the
 * sketch is unsafe or wrong for a real repo:
 *  - runs only on a dedicated branch with a clean tree (it uses `git reset --hard`
 *    to discard, which would destroy uncommitted work or `main`);
 *  - the agent only EDITS — the runner commits. A change touching any path outside
 *    `editable` (the metric script, the guard, program.md, this config) is reverted
 *    unseen, which is what stops the agent "improving" the number by changing the
 *    ruler;
 *  - direction `min` or `max`, not only "higher is better"; a crash, timeout,
 *    unparseable output, or failing guard is its own status and is discarded;
 *  - the metric is a line `metric: <number>` on stdout, not a bare last line, so a
 *    stray log line cannot become the score;
 *  - ties go to the simpler diff (more lines deleted than added keeps), per the
 *    simplicity criterion;
 *  - every `recheckEvery` kept steps HEAD is re-measured and the best is reset to
 *    that — on a noisy metric the best-of-N otherwise ratchets up on luck;
 *  - hard stops: iterations, minutes, a STOP file, N consecutive failures, SIGINT.
 *
 * It never pushes and never edits anything outside the working tree + its own log.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TSV_HEADER = ['iter', 'commit', 'metric', 'delta', 'status', 'seconds', 'description']
const PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'production', 'prod']

// ───────────────────────── pure helpers ─────────────────────────

/** The score from a command's stdout: the LAST line `metric: <number>`. null if none. */
function parseMetric(stdout) {
  let value = null
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^\s*metric\s*[:=]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/i)
    if (m) value = Number(m[1])
  }
  return Number.isFinite(value) ? value : null
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
  need('agent'); need('program'); need('editable')
  if (!c.metric || !c.metric.command) throw new Error('config: "metric.command" is required')
  if (!Array.isArray(c.editable) || c.editable.length === 0) throw new Error('config: "editable" must list at least one file')
  if (c.editable.some(e => /^(\.\/)?\.?\/?$|^\.\.|^\//.test(String(e)) || String(e) === '.')) {
    throw new Error('config: "editable" entries must be repo-relative files or directories (ending in /), never "." or absolute')
  }
  const direction = c.metric.direction || 'min'
  if (direction !== 'min' && direction !== 'max') throw new Error('config: metric.direction must be "min" or "max"')
  return {
    program: c.program,
    agent: c.agent,
    editable: c.editable.map(toPosix),
    metric: { command: c.metric.command, direction, timeoutSec: c.metric.timeoutSec || 300, tolerance: c.metric.tolerance || 0, minImprovement: c.metric.minImprovement || 0 },
    guard: c.guard ? { command: c.guard.command || c.guard, timeoutSec: c.guard.timeoutSec || 600 } : null,
    agentTimeoutSec: c.agentTimeoutSec || 900,
    maxIterations: c.maxIterations || 20,
    maxMinutes: c.maxMinutes || 120,
    maxConsecutiveFailures: c.maxConsecutiveFailures || 5,
    recheckEvery: c.recheckEvery == null ? 5 : c.recheckEvery,
    stateDir: c.stateDir || '.karpathy-loop',
    allowBranch: !!c.allowBranch,
    baseDir,
  }
}

function tsvRow(fields) {
  return fields.map(v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ')).join('\t')
}

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
    commitAll: (msg) => {
      git('add -A')
      return git(`-c user.name="karpathy-loop" -c user.email="karpathy-loop@localhost" commit -q --no-gpg-sign -m ${JSON.stringify(msg)}`)
    },
  }
}

// ───────────────────────── the loop ─────────────────────────

function buildPrompt(cfg, iter, programText, history, best, baseline) {
  const recent = history.slice(-12).map(h => `  #${h.iter} ${h.status} ${h.metric == null ? '-' : h.metric}  ${h.description}`).join('\n') || '  (none yet)'
  return [
    programText.trim(),
    '',
    '---',
    `# Loop state (iteration ${iter})`,
    `Metric: ${cfg.metric.direction === 'max' ? 'HIGHER' : 'LOWER'} is better. Original baseline: ${baseline}. Current best: ${best}.`,
    `You may edit ONLY: ${cfg.editable.join(', ')}. Anything else is reverted unseen.`,
    'Make exactly ONE targeted change (one hypothesis). Do NOT run git commit/reset — the runner commits, measures, and keeps or discards.',
    `Before you finish, write a one-line description of what you changed and why to ${cfg.stateDir}/description.txt.`,
    'Recent experiments (do not repeat a discarded idea):',
    recent,
  ].join('\n')
}

function run(rawConfig, { log = console.log, now = () => Date.now(), stopSignal = { stop: false } } = {}) {
  const cfg = normalizeConfig(rawConfig, rawConfig.baseDir)
  const cwd = cfg.baseDir
  const g = makeGit(cwd)
  const stateDir = path.join(cwd, cfg.stateDir)
  const resultsPath = path.join(stateDir, 'results.tsv')
  const descPath = path.join(stateDir, 'description.txt')
  const stopFile = path.join(stateDir, 'STOP')
  const out = { iterations: 0, kept: 0, history: [], stoppedBecause: null }

  // ── preflight ──
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
  const programPath = path.join(cwd, cfg.program)
  if (!fs.existsSync(programPath)) throw new Error(`program file not found: ${cfg.program}`)
  const programText = fs.readFileSync(programPath, 'utf8')
  if (inScope(cfg.program, cfg.editable)) throw new Error('program file must not be editable by the agent')
  fs.mkdirSync(stateDir, { recursive: true })
  try { fs.unlinkSync(stopFile) } catch { /* none */ }
  if (!fs.existsSync(resultsPath)) fs.writeFileSync(resultsPath, TSV_HEADER.join('\t') + '\n')
  const append = (row) => fs.appendFileSync(resultsPath, tsvRow(TSV_HEADER.map(k => row[k])) + '\n')

  const measure = () => {
    const r = sh(cfg.metric.command, { cwd, timeoutSec: cfg.metric.timeoutSec })
    if (r.timedOut) return { ok: false, why: 'metric timed out' }
    if (r.code !== 0) return { ok: false, why: `metric exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ')}` }
    const value = parseMetric(r.stdout)
    if (value == null) return { ok: false, why: 'no "metric: <number>" line in output' }
    return { ok: true, value }
  }

  // ── baseline ──
  const base0 = measure()
  if (!base0.ok) throw new Error(`baseline measurement failed: ${base0.why}`)
  if (cfg.guard) {
    const gr = sh(cfg.guard.command, { cwd, timeoutSec: cfg.guard.timeoutSec })
    if (gr.code !== 0) throw new Error('guard fails on the unmodified baseline — fix that first, or every experiment would be discarded')
  }
  const baseline = base0.value
  let best = baseline
  let keptSinceRecheck = 0
  let failStreak = 0
  const startedAt = now()
  append({ iter: 0, commit: g.head(), metric: baseline, delta: 0, status: 'baseline', seconds: 0, description: 'baseline' })
  log(`baseline ${baseline} on ${branch}@${g.head()} (${cfg.metric.direction === 'max' ? 'higher' : 'lower'} is better)`)

  for (let iter = 1; iter <= cfg.maxIterations; iter++) {
    if (stopSignal.stop) { out.stoppedBecause = 'interrupted'; break }
    if (fs.existsSync(stopFile)) { out.stoppedBecause = 'STOP file'; break }
    if ((now() - startedAt) / 60000 >= cfg.maxMinutes) { out.stoppedBecause = `maxMinutes (${cfg.maxMinutes})`; break }
    if (failStreak >= cfg.maxConsecutiveFailures) { out.stoppedBecause = `${failStreak} consecutive failures`; break }

    const t0 = now()
    const parent = g.run('rev-parse HEAD').stdout.trim()
    try { fs.unlinkSync(descPath) } catch { /* none */ }
    const record = (status, metric, description, extra = {}) => {
      const row = {
        iter, commit: g.head(), metric: metric == null ? '' : metric,
        delta: metric == null ? '' : +improvement(cfg.metric.direction, best, metric).toFixed(6),
        status, seconds: Math.round((now() - t0) / 1000), description,
      }
      append(row); out.history.push({ ...row, ...extra }); out.iterations = iter
      log(`#${iter} ${status}${metric == null ? '' : ' ' + metric} — ${description}`)
    }

    // 1. the agent proposes a change
    const prompt = buildPrompt(cfg, iter, programText, out.history, best, baseline)
    const ar = sh(cfg.agent, { cwd, input: prompt, timeoutSec: cfg.agentTimeoutSec, env: { KARPATHY_ITERATION: String(iter) } })
    const described = fs.existsSync(descPath) ? fs.readFileSync(descPath, 'utf8').trim().split('\n')[0].slice(0, 200) : ''
    const description = described || `experiment ${iter}`
    if (ar.timedOut || ar.error) { g.resetTo(parent); failStreak++; record('crash', null, `agent ${ar.timedOut ? 'timed out' : 'failed'}: ${ar.error || ''}`.trim()); continue }

    // 2. scope: only editable files may change
    const changed = g.changed()
    if (changed.length === 0) { failStreak++; record('noop', null, description); continue }
    const bad = scopeViolations(changed, cfg.editable)
    if (bad.length) { g.resetTo(parent); failStreak++; record('scope-violation', null, `touched ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`); continue }

    // 3. commit it (the runner owns history)
    const cm = g.commitAll(`experiment ${iter}: ${description}`)
    if (cm.code !== 0) { g.resetTo(parent); failStreak++; record('crash', null, `commit failed: ${cm.stderr.trim().slice(0, 120)}`); continue }
    const sha = g.head()
    const { added, deleted } = g.numstat(`${parent} ${sha}`)

    // 4. guard (e.g. tests must still pass)
    if (cfg.guard) {
      const gr = sh(cfg.guard.command, { cwd, timeoutSec: cfg.guard.timeoutSec })
      if (gr.code !== 0) { g.resetTo(parent); failStreak++; record('guard-fail', null, description); continue }
    }

    // 5. measure
    const m = measure()
    if (!m.ok) { g.resetTo(parent); failStreak++; record('crash', null, `${description} (${m.why})`); continue }

    // 6. keep or discard
    const d = decide({ direction: cfg.metric.direction, best, candidate: m.value, minImprovement: cfg.metric.minImprovement, tolerance: cfg.metric.tolerance, added, deleted })
    if (d.keep) {
      record('keep', m.value, d.reason === 'simpler' ? `${description} (simpler, same score)` : description, { sha })
      best = d.reason === 'simpler' ? best : m.value
      out.kept++; keptSinceRecheck++; failStreak = 0
    } else {
      record('discard', m.value, description)
      g.resetTo(parent)
      failStreak = 0
    }

    // 7. noise guard: re-measure HEAD; best must not ratchet on luck
    if (cfg.recheckEvery > 0 && keptSinceRecheck >= cfg.recheckEvery) {
      const rc = measure()
      if (rc.ok) {
        append({ iter, commit: g.head(), metric: rc.value, delta: +improvement(cfg.metric.direction, best, rc.value).toFixed(6), status: 'recheck', seconds: 0, description: `re-measured HEAD (best was ${best})` })
        log(`recheck HEAD ${rc.value} (best was ${best})`)
        best = rc.value
      }
      keptSinceRecheck = 0
    }
  }
  if (!out.stoppedBecause) out.stoppedBecause = `maxIterations (${cfg.maxIterations})`

  out.baseline = baseline
  out.best = best
  out.improvementVsBaseline = +improvement(cfg.metric.direction, baseline, best).toFixed(6)
  out.branch = branch
  out.head = g.head()
  log(`done: ${out.stoppedBecause}. ${out.kept} kept of ${out.iterations}. baseline ${baseline} → ${best} (${out.improvementVsBaseline >= 0 ? '+' : ''}${out.improvementVsBaseline} better). Log: ${path.relative(cwd, resultsPath)}`)
  return out
}

function main(argv) {
  const configPath = argv[2]
  if (!configPath || /^(-h|--help)$/.test(configPath)) {
    console.log('usage: node tools/karpathy-loop/loop.js <config.json>   (see tools/karpathy-loop/README.md)')
    return configPath ? 0 : 1
  }
  const abs = path.resolve(configPath)
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
  raw.baseDir = path.resolve(process.cwd(), raw.baseDir || '.')
  const stopSignal = { stop: false }
  process.on('SIGINT', () => { console.log('\nSIGINT — finishing this experiment, then stopping'); stopSignal.stop = true })
  try { run(raw, { stopSignal }); return 0 } catch (e) { console.error(`karpathy-loop: ${e.message}`); return 2 }
}

module.exports = { parseMetric, improvement, decide, inScope, scopeViolations, normalizeConfig, tsvRow, buildPrompt, run, TSV_HEADER, PROTECTED_BRANCHES }
if (require.main === module) process.exit(main(process.argv))
