'use strict'
/**
 * tools/karpathy-loop/loop.js — the pure decisions, then the whole loop run in a
 * throwaway git repo with a scripted "agent" (no model, no network).
 *
 * What is pinned and why:
 *  - the score is a `metric:` line, never a stray last line;
 *  - improvement is direction-aware; a tie keeps only the SIMPLER diff;
 *  - the agent cannot change the ruler: any path outside `editable` is reverted;
 *  - the loop refuses main/master and a dirty tree (it resets with --hard);
 *  - crashes / failing guard / no-op are logged and discarded, never kept;
 *  - the log is a real TSV and the final branch holds only kept experiments.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const L = require('../tools/karpathy-loop/loop')

describe('parseMetric', () => {
  test('takes the last `metric:` line; ignores other numbers', () => {
    expect(L.parseMetric('building 12 files\nmetric: 41.5\ndone 99')).toBe(41.5)
    expect(L.parseMetric('metric: 1\nmetric: 2')).toBe(2)
    expect(L.parseMetric('metric = -3e2')).toBe(-300)
  })
  test('no metric line, or a non-number, is null — a log line is not a score', () => {
    expect(L.parseMetric('99')).toBeNull()
    expect(L.parseMetric('metric: fast')).toBeNull()
    expect(L.parseMetric('')).toBeNull()
    expect(L.parseMetric(undefined)).toBeNull()
  })
})

describe('decide', () => {
  test('direction-aware improvement', () => {
    expect(L.decide({ direction: 'min', best: 100, candidate: 90 }).keep).toBe(true)
    expect(L.decide({ direction: 'min', best: 100, candidate: 110 }).keep).toBe(false)
    expect(L.decide({ direction: 'max', best: 100, candidate: 110 }).keep).toBe(true)
    expect(L.decide({ direction: 'max', best: 100, candidate: 90 }).keep).toBe(false)
  })
  test('a tie keeps only a diff that deletes more than it adds', () => {
    expect(L.decide({ direction: 'min', best: 5, candidate: 5, added: 2, deleted: 9 })).toMatchObject({ keep: true, reason: 'simpler' })
    expect(L.decide({ direction: 'min', best: 5, candidate: 5, added: 9, deleted: 2 }).keep).toBe(false)
    expect(L.decide({ direction: 'min', best: 5, candidate: 5, added: 3, deleted: 3 }).keep).toBe(false)
  })
  test('minImprovement and tolerance both gate a keep', () => {
    expect(L.decide({ direction: 'min', best: 100, candidate: 99.5, minImprovement: 1 }).keep).toBe(false)
    expect(L.decide({ direction: 'min', best: 100, candidate: 98, minImprovement: 1 }).keep).toBe(true)
    expect(L.decide({ direction: 'min', best: 100, candidate: 99.9, tolerance: 0.5 }).keep).toBe(false)
  })
})

describe('scope', () => {
  test('exact files and directory prefixes', () => {
    const ed = ['server.js', 'lib/experiments/']
    expect(L.scopeViolations(['server.js', 'lib/experiments/a.js', 'lib/experiments/deep/b.js'], ed)).toEqual([])
    expect(L.scopeViolations(['server.js.bak', 'lib/experiments-x/a.js', 'tools/measure.js'], ed))
      .toEqual(['server.js.bak', 'lib/experiments-x/a.js', 'tools/measure.js'])
  })
  test('a bare directory name is not a prefix (needs the trailing slash)', () => {
    expect(L.inScope('lib/experiments/a.js', ['lib/experiments'])).toBe(false)
  })
})

describe('normalizeConfig', () => {
  const ok = { agent: 'x', program: 'p.md', editable: ['a.js'], metric: { command: 'm' } }
  test('defaults', () => {
    const c = L.normalizeConfig(ok, '/tmp')
    expect(c.metric.direction).toBe('min')
    expect(c.maxIterations).toBe(20)
    expect(c.stateDir).toBe('.karpathy-loop')
  })
  test('rejects missing pieces and whole-repo scope', () => {
    expect(() => L.normalizeConfig({ ...ok, agent: '' })).toThrow(/agent/)
    expect(() => L.normalizeConfig({ ...ok, metric: {} })).toThrow(/metric.command/)
    expect(() => L.normalizeConfig({ ...ok, editable: [] })).toThrow(/editable/)
    expect(() => L.normalizeConfig({ ...ok, editable: ['.'] })).toThrow(/never "\."/)
    expect(() => L.normalizeConfig({ ...ok, editable: ['/etc/passwd'] })).toThrow(/repo-relative/)
    expect(() => L.normalizeConfig({ ...ok, metric: { command: 'm', direction: 'up' } })).toThrow(/direction/)
  })
})

// ───────────── end to end in a temp repo ─────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * A repo whose metric is the number in `value.txt` and whose "agent" is a script
 * that reads the plan for this iteration from plan.json (kept outside the repo).
 */
function makeRepo({ branch = 'loop/test', guardFailsOn = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 't@t']); git(repo, ['config', 'user.name', 't'])
  fs.writeFileSync(path.join(repo, 'value.txt'), '100\n')
  fs.writeFileSync(path.join(repo, 'ruler.js'), "console.log('metric: ' + Number(require('fs').readFileSync('value.txt','utf8')))\n")
  fs.writeFileSync(path.join(repo, 'guard.js'), `process.exit(Number(require('fs').readFileSync('value.txt','utf8')) === ${guardFailsOn === null ? -1 : guardFailsOn} ? 1 : 0)\n`)
  fs.writeFileSync(path.join(repo, 'program.md'), 'Lower the number in value.txt.\n')
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'init'])
  if (branch !== 'main') git(repo, ['switch', '-q', '-c', branch])

  const planPath = path.join(root, 'plan.json')
  const agentPath = path.join(root, 'agent.js')
  fs.writeFileSync(agentPath, `
    const fs = require('fs')
    const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}, 'utf8'))
    const step = plan[Number(process.env.KARPATHY_ITERATION) - 1] || {}
    for (const [f, v] of Object.entries(step.write || {})) { fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, v) }
    if (step.crash) process.exit(1)
    if (step.desc) { fs.mkdirSync('.karpathy-loop', { recursive: true }); fs.writeFileSync('.karpathy-loop/description.txt', step.desc) }
    fs.readFileSync(0)  // consume the prompt
  `)
  const setPlan = (p) => fs.writeFileSync(planPath, JSON.stringify(p))
  const config = (extra = {}) => ({
    baseDir: repo, program: 'program.md', agent: `node ${agentPath}`,
    editable: ['value.txt'], metric: { command: 'node ruler.js', direction: 'min' },
    guard: 'node guard.js', maxIterations: 3, recheckEvery: 0, ...extra,
  })
  return { root, repo, setPlan, config }
}

const quiet = { log: () => {} }
const rows = (repo) => fs.readFileSync(path.join(repo, '.karpathy-loop/results.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'))

describe('loop (temp git repo, scripted agent)', () => {
  test('keeps improvements, discards regressions, ignores edits to the ruler', () => {
    const { repo, setPlan, config } = makeRepo()
    setPlan([
      { write: { 'value.txt': '90\n' }, desc: 'lower to 90' },                                   // keep
      { write: { 'value.txt': '95\n' }, desc: 'regress to 95' },                                 // discard (worse than 90)
      { write: { 'value.txt': '80\n', 'ruler.js': "console.log('metric: 0')\n" }, desc: 'cheat' }, // scope violation
    ])
    const out = L.run(config(), quiet)
    expect(out).toMatchObject({ baseline: 100, best: 90, kept: 1, iterations: 3 })
    expect(out.improvementVsBaseline).toBe(10)
    const t = rows(repo)
    expect(t[0]).toEqual(L.TSV_HEADER)
    expect(t.slice(1).map(r => r[4])).toEqual(['baseline', 'keep', 'discard', 'scope-violation'])
    // the working tree holds the kept experiment only, and the ruler is untouched
    expect(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8').trim()).toBe('90')
    expect(fs.readFileSync(path.join(repo, 'ruler.js'), 'utf8')).toContain('readFileSync')
    expect(git(repo, ['log', '--format=%s']).split('\n')[0]).toBe('experiment 1: lower to 90')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
  })

  test('crash, no-op and failing guard are logged and never kept', () => {
    const { repo, setPlan, config } = makeRepo({ guardFailsOn: 50 })
    setPlan([
      { write: { 'value.txt': 'oops\n' }, desc: 'break the metric' },  // metric prints NaN → crash
      {},                                                              // agent changed nothing
      { write: { 'value.txt': '50\n' }, desc: 'fast but breaks guard' },
    ])
    const out = L.run(config(), quiet)
    expect(out.kept).toBe(0)
    expect(rows(repo).slice(1).map(r => r[4])).toEqual(['baseline', 'crash', 'noop', 'guard-fail'])
    expect(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8').trim()).toBe('100')
  })

  test('a tie is kept only when the diff is simpler', () => {
    const { repo, setPlan, config } = makeRepo()
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'a\nb\nc\nd\ne\n')
    git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'notes'])
    setPlan([
      { write: { 'notes.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' }, desc: 'add lines, same score' },  // discard
      { write: { 'notes.txt': 'a\n' }, desc: 'delete lines, same score' },                    // keep (simpler)
    ])
    const out = L.run(config({ editable: ['value.txt', 'notes.txt'], maxIterations: 2 }), quiet)
    expect(rows(repo).slice(2).map(r => r[4])).toEqual(['discard', 'keep'])
    expect(out.best).toBe(100)
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('a\n')
  })

  test('stops after N consecutive failures and on a STOP file', () => {
    const a = makeRepo()
    a.setPlan([])   // agent never changes anything → noop each time
    const out = L.run(a.config({ maxIterations: 10, maxConsecutiveFailures: 2 }), quiet)
    expect(out.stoppedBecause).toMatch(/2 consecutive failures/)
    expect(out.iterations).toBe(2)

    const b = makeRepo()
    b.setPlan([{ write: { 'value.txt': '90\n' }, desc: 'x' }])
    const out2 = L.run(b.config({ maxIterations: 10 }), { log: (m) => { if (/^#1 keep/.test(m)) fs.writeFileSync(path.join(b.repo, '.karpathy-loop/STOP'), '') } })
    expect(out2.stoppedBecause).toBe('STOP file')
    expect(out2.iterations).toBe(1)
  })

  test('recheck re-measures HEAD and resets best (no ratcheting on noise)', () => {
    const { repo, setPlan, config } = makeRepo()
    setPlan([{ write: { 'value.txt': '90\n' }, desc: 'x' }])
    const out = L.run(config({ maxIterations: 1, recheckEvery: 1 }), quiet)
    expect(rows(repo).slice(1).map(r => r[4])).toEqual(['baseline', 'keep', 'recheck'])
    expect(out.best).toBe(90)
  })

  test('refuses main, a dirty tree, a failing baseline guard and an editable program file', () => {
    const m = makeRepo({ branch: 'main' })
    expect(() => L.run(m.config(), quiet)).toThrow(/refusing to run on "main"/)

    const d = makeRepo()
    fs.writeFileSync(path.join(d.repo, 'value.txt'), '1\n')
    expect(() => L.run(d.config(), quiet)).toThrow(/uncommitted/)

    const g = makeRepo({ guardFailsOn: 100 })
    expect(() => L.run(g.config(), quiet)).toThrow(/guard fails on the unmodified baseline/)

    const p = makeRepo()
    expect(() => L.run(p.config({ editable: ['program.md'] }), quiet)).toThrow(/program file must not be editable/)
  })

  test('a baseline that does not print a metric stops before any experiment', () => {
    const { repo, config } = makeRepo()
    fs.writeFileSync(path.join(repo, 'ruler.js'), "console.log('hello')\n")
    git(repo, ['commit', '-qam', 'broken ruler'])
    expect(() => L.run(config(), quiet)).toThrow(/baseline measurement failed/)
  })
})

describe('bundle-size example ruler', () => {
  test('prints the gzipped KB of dist/assets/*.js only', () => {
    const zlib = require('zlib')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-dist-'))
    fs.mkdirSync(path.join(dir, 'assets'))
    const js = 'x'.repeat(20000)
    fs.writeFileSync(path.join(dir, 'assets/a.js'), js)
    fs.writeFileSync(path.join(dir, 'assets/a.css'), 'y'.repeat(50000))   // not counted
    const { gzippedKb } = require('../tools/karpathy-loop/examples/bundle-size/measure')
    expect(gzippedKb(dir)).toBeCloseTo(zlib.gzipSync(js, { level: 9 }).length / 1024, 1)
    const r = spawnSync('node', [path.join(__dirname, '../tools/karpathy-loop/examples/bundle-size/measure.js'), '--no-build'], { env: { ...process.env, DIST_DIR: dir }, encoding: 'utf8' })
    expect(L.parseMetric(r.stdout)).toBe(gzippedKb(dir))
    expect(() => gzippedKb(path.join(dir, 'nope'))).toThrow(/no .*assets/)
  })
})
