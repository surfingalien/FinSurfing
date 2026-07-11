# Fable 5 — Thinking, Fixing & Building Procedures

Executable instructions for how the model thinks through code, fixes defects, and builds new capabilities. Every rule is trigger → action — no advice, only steps. Part C shows how to adapt the procedures to any module in this repo (or another repo).

---

## Part A — Thinking & Fixing

### A1. Intake

- **When you receive a bug report or task**, extract three facts before touching any tool: (a) expected behavior, (b) observed behavior, (c) the exact input/command that produces it. If any of the three is missing from the report, search the repo for it (test names, error strings); ask the user only if the repo can't supply it.
- **When the report contains an error message**, grep the verbatim string (not a paraphrase) across the repo first. Trim variable parts (paths, IDs) before grepping.
- **When the task says "fix X" and X names a symptom ("crashes", "wrong total")**, treat the location of the symptom as unknown — do not assume the file the user mentions is the file with the defect.

**Worked example:** Report: "checkout crashes, fix cart.py." Grep the traceback string → it originates in `pricing.py:88`, which `cart.py` merely calls. Editing `cart.py` would have patched the call site, not the defect.

**Failure prevented:** fixing the file the user named instead of the file that's broken.

### A2. Reproduce before diagnosing

- **When the failure is runnable** (test, script, command), run it once unmodified and save the exact output before reading any source. The saved output is the baseline every later claim is checked against.
- **When you cannot run it** (no env, missing creds), write down the one-sentence prediction of what the failing output would be, and mark every later conclusion as "unverified — reasoned from source" in the final answer.
- **When the failure doesn't reproduce**, stop diagnosing. Report the non-repro with the exact command and output; do not fix code for a failure you never saw.

**Worked example:** "Test test_refund fails." Run it → it passes locally. Instead of "fixing" the assertion by inspection, report non-repro; the real cause turns out to be a stale CI cache, and a code edit would have introduced a change with no purpose.

**Failure prevented:** shipping a fix for a phantom bug.

### A3. Localize by evidence, not plausibility

- **When you have a traceback**, open the deepest frame that is in this repo (not a library) first. Read 30 lines around it before forming any theory.
- **When there is no traceback**, bisect by data: find the last point in the flow where the value is correct and the first where it's wrong. Add a temporary print/log at the midpoint, run, halve again. Remove all temporary instrumentation before the final diff.
- **When two theories fit the evidence**, run the one-command experiment that distinguishes them before writing any fix. If no such experiment exists, state both in the answer and fix the one the evidence weights, saying so.

**Worked example:** Wrong currency total. Value correct after `parse()`, wrong after `convert()` → defect is inside `convert()`. Without the bisect, the plausible-looking rounding code in `format()` would have been "fixed" — it was fine.

**Failure prevented:** editing plausible code instead of guilty code.

### A4. Root cause, not symptom

- **When the minimal fix is "add a None-check / try-except / default value"**, first answer in one sentence: *why* is the value None here? If the answer is "an upstream function violated its own contract," fix the upstream function; add the guard only if the contract legitimately allows None.
- **When the same defect pattern could exist elsewhere**, grep for the pattern (same function, same misuse) after fixing the first instance, and fix or list every other hit in the answer.

**Worked example:** `KeyError: 'user_id'` in handler. The tempting fix is `.get('user_id')`. One-sentence why: the login route builds the session dict without `user_id` on OAuth logins. Fix the session builder; a `.get()` would have converted the crash into silently unattributed orders.

**Failure prevented:** suppressing the error while keeping the bug.

### A5. Design the diff before writing it

- **When you know the cause**, write the fix as the smallest diff that changes the defective behavior and nothing else. Before editing, list every file you intend to touch; if the list exceeds 3 files for a bug fix, re-check whether you're refactoring instead of fixing — split the refactor out and mention it, don't do it.
- **When the fix changes a function's signature or return shape**, grep every caller before editing and update all of them in the same change.
- **When surrounding code has a style** (naming, error idiom, comment density), match it exactly. Do not add comments explaining the fix; the diff and commit message carry that.

**Worked example:** Fix requires `convert()` to take a `rate_date` param. Grep callers → 4 call sites, one in a test. Editing only the reported call path would have left 3 silently using the default and reintroduced the bug elsewhere.

**Failure prevented:** half-applied interface changes.

### A6. Verify against the baseline

- **When the edit is complete**, rerun the exact reproduction command from A2. The output must differ from the baseline in precisely the expected way. "Tests pass" without having seen them fail first proves nothing — if you never saw the failure, say so.
- **When a test suite exists**, run the narrowest suite covering the touched files, then the full suite if it runs in reasonable time. Paste failing output verbatim into the answer if anything fails — never summarize a failure as "mostly passing."
- **When the fix has a runtime surface** (endpoint, CLI, UI), drive it once end-to-end, not just its tests.
- **When no test covers the fixed behavior**, add one that fails on the pre-fix code. Confirm it fails there (stash the fix, run, unstash) before claiming it guards anything.

**Worked example:** New test for the OAuth session bug passes on first run. Stash the fix, rerun → it *still* passes. The test was asserting the wrong key; it guarded nothing. Rewrite until it fails pre-fix.

**Failure prevented:** green tests that verify nothing.

### A7. Side-effect sweep

- **When the diff is final**, read it once top-to-bottom as a reviewer: for each hunk, name the behavior it changes. Any hunk whose changed behavior you can't tie to the bug gets reverted.
- **When you touched shared code** (utils, base classes, config), grep for other consumers and state in the answer which ones you checked and why they're unaffected.
- **When you added instrumentation, debug flags, or commented-out code during diagnosis**, run `git diff` and confirm none of it remains.

**Worked example:** Final diff review finds a leftover `print(rate)` from the bisect in A3 and an unrelated import reorder the editor made. Both removed before commit.

**Failure prevented:** debris and drive-by changes shipping with the fix.

### A8. Report honestly

- **When writing the final answer**, state: cause (one sentence), fix (files + what changed), verification (commands run + observed results). Anything not verified is labeled unverified — no hedged wording that implies it was.
- **When a step was skipped or blocked**, say which and why, in the answer, not buried in a commit message.

**Worked example:** Full suite couldn't run (missing DB creds). Answer says: "Verified: targeted tests X, Y pass; full suite not run — requires DB access." Not: "tests pass."

**Failure prevented:** overclaiming verification.

---

## Part B — Building New Capabilities

### B1. Requirements before design

- **When asked to build a feature**, write the acceptance test first as one sentence: "Done means: given INPUT, the system produces OUTPUT, observable by COMMAND." If you cannot fill all three slots from the request, ask one batched question covering every gap — not a question per gap.
- **When the request names a technology or approach**, use it even if you'd prefer another; note the alternative in one line of the answer only if it materially changes cost or risk.
- **When the feature resembles something already in the repo**, find that precedent first (`grep` for similar route/component/function names) and copy its structure, wiring, and test style instead of inventing a new pattern.

**Worked example:** "Add a price-alerts endpoint." Grep finds `watchlist` endpoint: router file + service + schema + test, all in a fixed layout. Building alerts the same 4-file way avoids introducing a second, conflicting layout the next builder must reconcile.

**Failure prevented:** building the right feature in a shape the codebase doesn't recognize.

### B2. Interface first, internals second

- **When the capability will be called by other code**, write its public interface (function signatures, request/response schema, event shape) before any implementation, and validate it by writing the caller's side as a snippet. If the snippet is awkward, change the interface now — it's free now and expensive later.
- **When the capability owns state** (table, cache, file), define the schema and its migration/creation path in the same change; never let code assume state that nothing in the repo creates.
- **When a module boundary is crossed** (frontend → backend, service → external API), define the error contract explicitly: what the caller sees on timeout, on bad input, on empty result. Write those three cases into the tests before the happy path.

**Worked example:** Alerts API drafted as `POST /alerts {symbol, price}`. Writing the frontend caller snippet reveals the UI also needs `direction` (above/below). Caught at interface stage: one line. Caught after implementation: schema change, migration, and UI rework.

**Failure prevented:** interfaces discovered to be wrong only after both sides are built.

### B3. Build in verifiable increments

- **When implementation starts**, order the work so every increment is runnable: skeleton that returns a hardcoded value → real logic → edge cases. Run the acceptance command from B1 after each increment; never write more than one increment ahead of the last passing run.
- **When an increment needs a dependency** (package, service, key), install/configure it at the moment that increment needs it and record the exact command in the answer — not a pile of setup at the end.
- **When you stub something** (mock data, TODO, fake auth), grep-tag it with a single consistent marker (`STUB:`) and, before finishing, grep that marker — every remaining hit is either implemented or listed in the answer as explicitly out of scope.

**Worked example:** Alerts feature done, final `grep STUB:` finds `STUB: always returns triggered=true` left in the evaluator from increment 2. Without the marker sweep it ships as a feature that fires every alert every minute.

**Failure prevented:** half-implemented internals hiding behind a working-looking surface.

### B4. Integrate, don't just add

- **When the new capability is complete in isolation**, wire it into every surface that should expose it (router registration, nav/menu, config, docs/README section that lists such features) — grep for how the precedent from B1 is wired and mirror every wiring point.
- **When the capability changes shared config or dependencies** (requirements.txt, package.json, env vars), state each addition in the answer with the reason, and add new env vars to the example/env template file if one exists.
- **When done**, run the module's full existing test suite and start the app once — a new feature that breaks an old one is a regression, not a delivery.

**Worked example:** New alerts router works via curl but grep of the watchlist precedent shows routers are registered in `app/main.py` *and* listed in the OpenAPI tags config. The second wiring point was missed; mirroring the precedent catches it.

**Failure prevented:** features that exist in the codebase but not in the product.

---

## Part C — Adapting these procedures to other modules

The triggers stay the same in every module; only the concrete commands change. To adapt, fill this table for the target module and substitute its entries wherever a procedure says "run", "test", or "drive end-to-end":

| Slot | Question to answer once per module |
|---|---|
| RUN | What single command starts this module? |
| TEST | What single command runs its tests (or, if none, what manual check substitutes)? |
| REPRO | Where do failures surface (traceback, browser console, CI log, chart)? |
| PRECEDENT | Which existing file is the canonical example of a feature in this module? |
| WIRING | Which files must reference a new component for it to be live? |

Filled in for this repo (finsurf):

- **Backend** (Node/Express: `server.js`, `routes/`, `services/`, `middleware/`, `lib/`, `utils/`) — RUN: `npm run start` (`npm run dev` for backend + frontend together); TEST: `npm test` (Jest over `tests/`); REPRO: server console traceback / HTTP response; PRECEDENT: an existing route file in `routes/` with its matching `tests/*.test.js`; WIRING: route registration in `server.js`, `package.json` for deps.
- **Frontend** (Vite + React + Tailwind: `src/`, `public/`) — RUN: `npm run dev`; TEST: `npm run build` plus any matching Jest tests; REPRO: browser console and network tab; PRECEDENT: an existing component in `src/`; WIRING: import + route/parent component, `package.json` for deps.
- **timesfm_service/** (Python forecasting service) — RUN: per `timesfm_service/main.py`; TEST: none — substitute a request against the running service with the response pasted in the answer; REPRO: service stdout traceback; PRECEDENT: `main.py` itself; WIRING: `timesfm_service/requirements.txt`, plus the backend route that calls it (e.g. `routes/forecast.js`).
- **openbb-sidecar/** (Dockerized market-data sidecar) — RUN: via its `Dockerfile`/`start.sh` (config-driven; often not locally runnable → A2 "unverified" labeling applies); TEST: none — substitute one request through the backend route that consumes it; PRECEDENT: `user_settings.template.json`; WIRING: `user_settings.template.json`, `railway.toml`.

**Adaptation rule:** When you enter a module without a filled table, fill it *before* the first edit (read its Dockerfile/package.json/README to answer the slots). When a slot has no answer (no tests, not locally runnable), the procedures don't relax — the A2 "unverified" labeling rule activates instead.

**Worked example:** A fix in `openbb-sidecar/start.sh` cannot be executed locally without the deployment environment. The table says RUN/TEST are unavailable → the answer must label the fix "unverified — reasoned from source" and include the exact deploy-and-check steps to verify. Claiming "tested" here would be the A8 failure.

**Failure prevented:** applying backend-shaped verification claims to modules that can't support them.

---

## Final gate — run on every answer before sending

1. Did I reproduce, or run the B1 acceptance command (or explicitly mark unverified)?
2. Does the diff contain only hunks I can tie to the cause or the stated feature?
3. Did I rerun the original reproduction / acceptance command and see it change as expected?
4. Does at least one test fail on the pre-change code and pass now (where the module's table has a TEST entry)?
5. Did I grep all callers of anything whose interface changed, and mirror every WIRING point of the precedent?
6. Is all debug instrumentation and every `STUB:` marker removed or explicitly listed as out of scope (`git diff` + grep checked)?
7. Does the answer separate verified claims from reasoned ones?

**If any item fails: fix it and re-run the gate from item 1. Never send anyway.**
