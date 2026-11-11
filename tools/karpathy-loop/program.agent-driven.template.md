# Goal
<What to optimise, in one sentence.> The score is `<command>`, which prints `metric: <number>`.
<Lower|Higher> is better. <Optional: `metric.<name>: <n>` lines are secondary metrics; the loop logs
them and enforces any limit in the config.>

# What you may change
Only: <files>. Anything else is reverted without being looked at (the metric script, the tests,
this file and the loop config included).

# How the loop works — you drive it, the tool keeps it honest
You are one long-lived session; the tool does the git, the measuring and the logging. Never run
`git commit`, `git reset` or edit `.karpathy-loop/`. `<config>` below is `<path/to/config.json>`.

Setup (once, with the human): confirm the branch is a dedicated one (not main), then
`node tools/karpathy-loop/loop.js init <config>` — it measures the baseline and prints it. Tell the
human the baseline and wait for a go. After that, do not ask whether to continue.

Each experiment:
1. State one hypothesis (what you will change and why it should help). Change the editable files.
2. `node tools/karpathy-loop/loop.js step <config> "<one-line description>"`. It checks scope, commits,
   runs the guard and the metric, then keeps or discards for you, and prints JSON.
3. Read `status`:
   - `keep` — the branch advanced; build on it.  `discard` / `constraint-fail` — it was reset; the idea
     is dead, do not repeat it.  `scope-violation` / `noop` — fix your approach.
   - `retry` — your change crashed or failed the guard but is still committed. `error` says why and
     `fixesLeft` how many fixes remain. If it is a small mistake (typo, missing import), fix the file
     and call `step <config>` again (no description needed). If the idea itself is broken, run
     `step <config> --abandon`.
4. If the JSON has a non-null `stop`, the loop is finished (iteration, time or failure budget, or a
   STOP file). Stop, then summarise the kept experiments from `status` / `.karpathy-loop/results.tsv`.
   Otherwise go to 1.

If you run out of ideas: re-read the editable files for new angles, combine near-misses from the
recent list (`node tools/karpathy-loop/loop.js status <config>`), try something more radical.

# Rules
- One hypothesis per experiment.
- <Things that must keep working — name the test or check.>
- No new dependencies.
- Simpler wins: the same score with less code is kept; a tiny gain that costs a lot of code is not.

# Ideas not yet tried
- <seed list; you may go beyond it>
