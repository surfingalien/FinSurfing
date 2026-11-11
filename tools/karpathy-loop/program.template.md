# Goal
<What to optimise, in one sentence.> The score is `<command>`, which prints `metric: <number>`.
<Lower|Higher> is better.

# What you may change
Only: <files>. Anything else is reverted without being looked at (the metric script, the tests,
this file and the loop config included).

# Rules
- One hypothesis per experiment; say why it should help.
- <Things that must keep working — name the test or check.>
- No new dependencies.
- Simpler wins: the same score with less code is kept; a tiny gain that costs a lot of code is not.
- A discarded idea stays discarded — the recent experiments are listed under "Loop state".

# Ideas not yet tried
- <seed list; the agent may go beyond it>
