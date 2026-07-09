# Architecture

## Data flow

```text
input/brief.md + constraints.json
        |
        v
   [Planner] --model--> spec JSON --> SPEC.generated.md / PLAN.generated.md
        |
        v
   [Builder] --model--> { files[] } --> runs/<id>/app/   (safeJoin path jail)
        |
        v
   [Runner]  npm install -> npm run build -> vite preview -> Playwright screenshots
        |
        v
   [Reviewer] mechanical checks (exit codes, shot bytes, page text, page count)
        |                                   |
        | pass                              | fail (round < maxRepairRounds)
        v                                   v
   [Reporter]                          [Fixer] --model--> patched files --> back to Runner
```

## Module contracts

| module | input | output | model calls |
| --- | --- | --- | --- |
| `core/config.js` | targetDir | merged config (constraints > env > defaults) | 0 |
| `core/planner.js` | brief | spec JSON (pages+mustContain, scenarios) + 2 markdown artifacts | 1 |
| `core/builder.js` | brief + spec | fixed scaffold (package.json/vite.config) + model files under `app/` | 1 |
| `runner/commands.js` | appDir | command records + screenshots + page text + scenario results | 0 |
| `core/reviewer.js` | runner results + spec | `{ pass, checks[], failed[] }` incl. mustContain + scenarios | 0 |
| `core/fixer.js` | failure evidence | patched files + diagnosis | 1 per round |
| `reporter/deliveryReport.js` | run context + results | `DELIVERY_REPORT.md` | 0 |

## Safety boundaries

- **Path jail**: every model-provided path passes `safeJoin(appDir, path)`; absolute paths and `..` traversal throw.
- **No script execution from model output**: `package.json` and `vite.config.js` are fixed templates written by the pipeline, not the model. The model cannot write any manifest/lockfile/npmrc/config (`FORBIDDEN_FILES`), dependencies are a fixed whitelist (react, react-dom, react-router-dom), and `npm install` runs with `--ignore-scripts` so no `postinstall`/lifecycle hook ever executes.
- **Bounded repair**: at most `maxRepairRounds` fixer calls; exhaustion is recorded, never retried silently.
- **Command timeouts + process-tree kill**: each spawned command has a hard timeout and its whole tree (npm shim -> node -> vite) is killed via `taskkill /T` on Windows.
- **Free-port preview**: preview binds an OS-assigned free port, so stale processes or parallel runs never collide on 4173.
- **Honest status**: `success` requires the mechanical reviewer to pass; fatal errors land in the report under "Fatal error".
- **Token accounting**: every chat call's `usage` is accumulated on the run context and printed in the report.
- **Run output root**: `runs/` is resolved from the project root (not `targetDir/../..`), overridable via `VIBE_ONE_RUNS_DIR` or `constraints.runsRoot`.

## Extension points (post-MVP)

- `providers/`: add vision-capable calls for screenshot input (Phase 3).
- `reviewer`: add coarse screenshot-vs-reference comparison.
- `runner`: per-interaction Playwright scripts (click flows) instead of static shots.
