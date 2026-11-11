# Karpathy loop

An autonomous experiment loop (after Karpathy's `autoresearch`): an agent proposes **one** change, the
runner commits it, measures **one** number, and keeps it if the number improved, otherwise resets.
Repeat until a limit is hit. Standard-library Node, no dependencies; it never pushes.

```
agent edits → scope check → commit → guard (tests) → metric → keep | discard → results.tsv → repeat
```

## Run it

```bash
git switch -c loop/bundle-size          # a dedicated branch; the loop uses `git reset --hard`
node tools/karpathy-loop/loop.js tools/karpathy-loop/examples/bundle-size/config.json
```

It refuses to start on `main`/`master`/…, on a detached HEAD, with uncommitted changes, when the
baseline cannot be measured, or when the guard already fails on the untouched baseline.
Stop it with `Ctrl-C` (finishes the current experiment) or `touch .karpathy-loop/STOP`.
Afterwards the branch holds only the kept experiments; review it like any other branch.
The log is `.karpathy-loop/results.tsv` (git-excluded automatically):
`iter commit metric delta status seconds description`, with `status` one of
`baseline keep discard constraint-fail crash noop scope-violation guard-fail recheck`
(`secondary` holds `name=value` pairs; a crashed or retried experiment is one row, `(after N fixes)` in its description).
An older `results.tsv` with different columns is renamed aside, never appended to.

## Two ways to drive it

**Runner mode** (above): the runner calls `agent` once per experiment, a fresh process each time. It sees
the program, the loop state and the last 12 results, nothing else — cheap, bounded, easy to run unattended.

**Agent-driven mode**: one long-lived Claude session does the experiments and calls the tool for the
mechanical part, the way Karpathy's original `program.md` works. The agent keeps its own context, so it can
combine near-misses and change tack — at the price of a growing context. The agent never touches git:

```bash
node tools/karpathy-loop/loop.js init   <config.json>                 # preflight + baseline (once)
node tools/karpathy-loop/loop.js step   <config.json> "what and why"  # one experiment on the edits it just made
node tools/karpathy-loop/loop.js step   <config.json> --abandon       # give up on a crashed experiment
node tools/karpathy-loop/loop.js status <config.json>                 # state, pending fix, recent results
```

Each call prints JSON: `status` (`keep`, `discard`, `constraint-fail`, `crash`, `noop`, `scope-violation`,
`guard-fail` or `retry`), `metric`, `best`, and `stop` — non-null when a budget is spent, which is the
agent's cue to finish (the budgets are enforced here, not trusted to the model). State lives in
`.karpathy-loop/state.json`. Start the session from `program.agent-driven.template.md` and point it at that
file ("read the program and let's set up"). Both modes use the same `attempt()`, so every rule below applies
to both.

## The three files

| File | Role |
|---|---|
| `program.md` | What the human writes: goal, what may change, rules. Start from `program.template.md`. |
| the `editable` files | The only paths the agent may change. Anything else is reverted unseen. |
| `results.tsv` | The log of every experiment, kept or not. |

## Config (`config.json`)

| Key | Meaning |
|---|---|
| `program` | Path to program.md (must not be editable). Sent to the agent on stdin each iteration with the loop state. |
| `agent` | Shell command that reads the prompt on stdin and edits files, e.g. `claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Grep,Glob"`. It should not commit — the runner does. It may write a one-line description to `.karpathy-loop/description.txt`. `KARPATHY_ITERATION` is set. |
| `editable` | Repo-relative files, or directories ending in `/`. Never `.`. |
| `metric` | `{command, direction: "min"\|"max", timeoutSec, tolerance, minImprovement}`. The command prints `metric: <number>`; any other output is ignored. |
| `secondary` | Optional `{ "<name>": {direction, maxWorsePct} }` for lines `metric.<name>: <number>` the command also prints (build time, memory…). Always logged in the `secondary` column. With `maxWorsePct` it is a soft constraint: a step that makes it more than that % worse than the **original baseline** is `constraint-fail` even if the main metric improved. (Against the baseline, not the last step — a creeping +5% per kept step would never trip a step-to-step check.) The baseline must print a limited metric, and a limited metric that stops being printed fails the step. |
| `crashRetries` | Default 2. A crash or failing guard is not discarded at once: the agent gets the error and may fix it in place, amended into the same commit (one experiment, one commit), up to this many times; `0` = discard immediately. A fix that changes nothing, or touches anything out of scope, ends the experiment. |
| `guard` | Optional command that must exit 0 (e.g. the tests); a failure discards the experiment. |
| `maxIterations` `maxMinutes` `maxConsecutiveFailures` | Hard stops (defaults 20 / 120 / 5). |
| `recheckEvery` | Every N kept steps HEAD is re-measured and the best is reset to that, so a noisy metric cannot ratchet on luck (default 5, 0 = off). |
| `agentTimeoutSec` `stateDir` `allowBranch` | Defaults 900 / `.karpathy-loop` / false. |

## Why it differs from the original sketch

- **The agent cannot change the ruler.** Edits outside `editable` (the metric script, guard, program.md,
  this config) are reverted — otherwise the cheapest way to "improve" a number is to edit what measures it.
- **The runner owns git.** A dedicated branch + clean tree make `reset --hard` safe; the agent never commits.
- **Crashes, timeouts, no output, failing guard and no-ops are each a logged status**, never a keep — but a
  small mistake gets up to `crashRetries` fixes first, as in the original (typo: fix it; broken idea: skip it).
- **Secondary metrics** (the original logged memory beside val_bpb as a soft constraint) are logged and can be limited.
- **Ties go to the simpler diff** (more lines deleted than added) — the simplicity criterion.
- **A `metric:` line, not "the last line"**, so a stray log line cannot become the score.

## Pitfalls the loop cannot fix

- **Metric gaming / Goodhart**: the agent optimises the number, not the goal. Pick a metric that is hard to
  game, keep the guard strong, and read the branch before merging.
- **Local optima**: hill-climbing stalls. Run several loops from different starting branches.
- **Cost**: each iteration is a paid agent call. Keep `maxIterations` and `maxMinutes` small first.
- **Money code**: do not point it at code that places orders, sizes positions or changes risk limits.
  A hill-climbed backtest metric is exactly the kind of selection the repo's deflated-Sharpe / PBO / CPCV
  gates exist to catch; this loop has none of them.

Tests: `tests/karpathy-loop.test.js`. The bundle-size example measures gzipped JS in `dist/assets`
(`examples/bundle-size/measure.js`); `.claude/skills/autoresearch` is a different, interactive take on the idea.
