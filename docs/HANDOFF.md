# Vibe-one Handoff (Fable5 -> Codex)

This is the state-of-play and forward plan written for the Codex agent that takes over. Fable5 built the Phase 1 scaffold and hardened it against the first review round. Read `FRAMEWORK.md` (product boundary), `docs/architecture.md` (module contracts), then this file.

## What is DONE and verified

- **Full pipeline scaffold** (commit history in `history.md`): CLI -> planner -> builder -> runner -> reviewer -> fixer -> reporter, orchestrated in `src/core/pipeline.js`. Only claims `success` when the mechanical reviewer passes.
- **Real model calls now work through the whole pipeline** (opus-4-8 via the gateway below). Planner returns schema-matching JSON with real Chinese acceptance criteria; builder generates a 24-file app; the repair loop runs real rounds. Two hard real-model bugs were found and fixed by actually running it (see "Real-run lessons" below).
- **Pipeline verified end-to-end WITHOUT the API** (`VIBE_ONE_E2E=1 npm test`): a stub provider feeds a fixed spec + known-good React app through the real pipeline — real `npm install --ignore-scripts`, real `vite build`, real preview on a free port, real Playwright screenshots + interaction scenario, reviewer passes, report written.
- **13 offline unit tests + 1 e2e integration test, all passing**. Default `npm test` stays offline (~2s); e2e is opt-in via `VIBE_ONE_E2E=1`.

## Real-run lessons (found by running opus-4-8, not by reasoning)

1. **Never transport source files as a JSON string.** The builder originally asked the model for `{files:[{path,content}]}`. On a real app the model must escape every newline/quote/backslash into one JSON string and it corrupts around ~22KB — `JSON.parse` failed twice and the run went fatal with zero files. Fix: builder + fixer use a delimiter protocol (`=== FILE: path` / `=== END ===`) with raw code between markers. `parseFileBlocks` (in `builder.js`) has nothing to escape and scales to a full app. **Do not revert this to JSON.**
2. **A repair loop that can't see the code just guesses.** With only the build error text, the fixer misdiagnosed a missing export as a syntax error (round 1), then fixed one missing export but not a second of the same class (round 2), and exhausted the budget. Fix: `fix()` now sends the current model-authored source (`gatherSource`, skips node_modules + the fixed scaffold, bounded 40KB) so it patches against real code. If you tune the fixer, keep it source-aware.
- **Security review round 1 closed** (all five points from the first Codex review):
  1. *Arbitrary script execution* -> `package.json`/`vite.config.js` are fixed templates written by the pipeline; model cannot write manifest/lockfile/npmrc/config (`FORBIDDEN_FILES` in `builder.js`); deps whitelisted; `npm install --ignore-scripts`.
  2. *Shallow reviewer* -> planner now emits per-page `mustContain` text + structured `scenarios`; runner executes scenarios via Playwright (`runScenarios`); reviewer asserts both. A page full of random text no longer passes.
  3. *Fragile runDir* -> `runContext.js` resolves `runs/` from project root via `import.meta.url`, overridable by `VIBE_ONE_RUNS_DIR` / `constraints.runsRoot`.
  4. *Fixed preview port* -> `getFreePort()` binds an OS-assigned port; `killTree()` uses `taskkill /T` on Windows so vite children die.
  5. *Repo hygiene* -> `package-lock.json` committed; `runs/*` ignored except `.gitkeep`.

## What is NOT done yet (in priority order for Codex)

1. **Real model call has never executed.** The pipeline itself is now proven end-to-end by the stub e2e test, so the remaining risk is narrow: does the real model return JSON matching the planner/builder schemas? Run `node src/cli/index.js plan examples/expense-mobile` FIRST (one cheap call, no build), then `npm run demo:expense`. When schema drift appears, fix the SYSTEM prompt wording in `planner.js`/`builder.js` — do not loosen the schema consumers.
2. **Scenario target resolution is best-effort.** `resolveTarget()` in `runner/commands.js` maps a human-visible `target` string to a Playwright locator via role/text/placeholder/label heuristics. Real generated apps will expose gaps (e.g. a category picker that's a custom div, not a `<select>`). When a scenario fails for a *locator* reason rather than a *logic* reason, tighten the builder SYSTEM prompt to require accessible labels/roles, do NOT loosen the reviewer.
3. **Fixer prompt is untested against real failures.** `describeFailure()` now includes scenario failures, but the fix quality depends on the model. Watch the first repaired run: if the fixer returns partial files or drops the fixed scaffold, add a guard that re-writes the scaffold before each verify pass (currently only written once at build).
4. **No "failed-then-repaired" demo captured yet.** FRAMEWORK's interview bar needs one. Easiest path: seed a brief with a deliberately hard interaction, let round 0 fail, capture the repaired round. Keep that run's `DELIVERY_REPORT.md` + screenshots.
5. **Second demo (notes-mobile) unproven.** Only expense-mobile has been reasoned about end to end.

## Predicted failure modes (Fable5's forecast — check these first when something breaks)

- **JSON mode compat**: this gateway's `claude-*` models return ```json fenced blocks even in JSON mode; `extractJson()` already strips fences, but if a NEW model wraps differently, extend `extractJson`, don't sprinkle `try/catch`.
- **Rate limits**: the shared endpoint has low RPM/RPD (gpt-5.5 hit RPM=3, RPD=50). Provider has bounded 429 backoff (`openaiCompatible.js`), but a full run makes plan+build+2 fix = up to 4 calls; a flaky demo is probably rate-limit, not logic. Prefer a model with headroom (claude-opus-4-8 responded cleanly).
- **Windows npm shim**: `npm.cmd` is used, not `npm`. Preview/install spawn with `shell:false`; if you see ENOENT, it's the shim name, not the args.
- **`networkidle` hangs**: some Vite dev/preview pages keep a websocket open; screenshots use `waitUntil:'networkidle'` which can time out. If shots time out but the app is fine, switch to `'load'` + explicit `mustContain` wait.
- **Playwright first-run**: `chromium_headless_shell` is installed. If CI/another machine lacks it, `npx playwright install chromium` is required — documented in README.
- **Windows npm shim + Node 20.12+**: spawning `npm.cmd` with `shell:false` throws `EINVAL` (CVE-2024-27980 hardening). Already handled in `runner/commands.js` by shelling npm calls with a literal string; if you refactor spawning, this bites immediately and the e2e test will catch it.

## Working model endpoint (as of handoff)

An OpenAI-compatible gateway is available. Configure via env (never commit the key):

```
VIBE_ONE_BASE_URL=https://api.123nhh.com/v1
VIBE_ONE_MODEL=claude-opus-4-8      # responded cleanly to JSON mode in smoke tests
VIBE_ONE_API_KEY=<ask Gilbert>       # rotate; the smoke-test key is low-quota/shared
```

Smoke-test results already gathered: `claude-opus-4-8` works with `response_format:{type:'json_object'}`; `claude-sonnet-4-20250514` errored on this gateway; `gpt-5.3-codex`/`gpt-5.5-pro` need the `/v1/responses` endpoint (not chat/completions) so they are out of scope for the current provider; `gpt-5.5` is heavily rate-limited. **Recommendation: default to `claude-opus-4-8` for demos.**

## Guardrails for Codex (do NOT regress these)

- Keep the reviewer model-free. Its value is that results don't require trusting a model.
- Keep `--ignore-scripts` and the fixed package.json template. This is the core safety story for the interview.
- Never let the model write `package.json`/config — if a generated app legitimately needs a new dep, add it to the whitelist in `builder.js` deliberately, with a comment.
- Keep `success` gated on the full reviewer pass. Do not add a "close enough" status.
- Append durable milestones to `history.md`; keep the FRAMEWORK boundary (no screenshot recognition / multi-provider until Phase 3).

## Fast path to interview-ready

1. Set env, run `plan` on expense-mobile, fix any JSON schema drift in prompts.
2. Run `npm run demo:expense` to green. Commit the run's report + screenshots (or copy them into `docs/` for the README).
3. Repeat for notes-mobile.
4. Engineer one failed-then-repaired run; keep its artifacts.
5. Add 2-3 README screenshots + link `docs/interview-positioning.md`.
