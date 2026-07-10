# Architecture

## Data flow

```text
input/brief.md + constraints.json
        |
        v
   [Planner] --model--> spec JSON --> SPEC.generated.md / PLAN.generated.md
        |
        v
   [Builder] --model--> delimited file blocks --> runs/<id>/app/   (safeJoin path jail)
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
| `providers/openaiCompatible.js` | system + user prompts | streamed or JSON chat result + usage | 1 per request |
| `core/planner.js` | brief | spec JSON (pages+mustContain, scenarios) + 2 markdown artifacts | 1 |
| `core/builder.js` | brief + spec | fixed scaffold (package.json/vite.config) + model files under `app/` | 1 |
| `runner/commands.js` | appDir | command records + screenshots + page text + scenario results | 0 |
| `core/reviewer.js` | runner results + spec | `{ pass, checks[], failed[] }` incl. mustContain + scenarios | 0 |
| `core/fixer.js` | failure evidence | patched files + diagnosis | 1 per round |
| `reporter/deliveryReport.js` | run context + results | `DELIVERY_REPORT.md` | 0 |

## Local console flow

```text
browser workspace
    |  JSON commands + SSE events
    v
[console/server] -> [job manager] -> runPipeline()
       |                 |
       |                 +-> session-only credentials + one active job
       |
       +-> [run store] -> reports / screenshots / persisted history
       |
       +-> [preview manager] -> one owned Vite preview process
```

| console module | responsibility |
| --- | --- |
| `console/server.js` | loopback HTTP routing, SSE clients, static assets, and shutdown |
| `console/jobManager.js` | session config, validation, one-active-job state, event fan-out |
| `console/runStore.js` | reconstruct public run metadata and jail report/screenshot reads |
| `console/previewManager.js` | reuse one generated-app preview and stop it on replacement/shutdown |
| `console/public/` | framework-free responsive browser workspace |

The console calls `runPipeline()` in process. `runContext.logEvent()` persists each event to `events.jsonl` before mirroring it to the job manager, so browser delivery never replaces the durable audit trail.

## Safety boundaries

- **Path jail**: every model-provided path passes `safeJoin(appDir, path)`; absolute paths and `..` traversal throw.
- **No script execution from model output**: `package.json` and `vite.config.js` are fixed templates written by the pipeline, not the model. The model cannot write any manifest/lockfile/npmrc/config (`FORBIDDEN_FILES`), dependencies are a fixed whitelist (react, react-dom, react-router-dom), and `npm install` runs with `--ignore-scripts` so no `postinstall`/lifecycle hook ever executes.
- **Bounded repair**: at most `maxRepairRounds` fixer calls; exhaustion is recorded, never retried silently.
- **Command timeouts + process-tree kill**: each spawned command has a hard timeout and its whole tree (npm shim -> node -> vite) is killed via `taskkill /T` on Windows.
- **Free-port preview**: preview binds an OS-assigned free port, so stale processes or parallel runs never collide on 4173.
- **Honest status**: `success` requires the mechanical reviewer to pass; fatal errors land in the report under "Fatal error".
- **Token accounting**: every chat call's `usage` is accumulated on the run context and printed in the report.
- **Run output root**: `runs/` is resolved from the project root (not `targetDir/../..`), overridable via `VIBE_ONE_RUNS_DIR` or `constraints.runsRoot`.
- **Gateway resilience**: chat completions stream by default, retry network/429/500/502/503/504 failures within a hard budget, and use a separate 10-minute streaming timeout.
- **Bounded model output**: the text-brief builder asks for at most 8 files and roughly 12,000 characters so a generated MVP stays inspectable and gateway-friendly.
- **Loopback-only console**: the HTTP server binds `127.0.0.1` by default and does not expose the control plane to the LAN.
- **Session-only secret**: browser-entered API keys stay in process memory, are removed from public job objects, and are never written into console inputs or run artifacts.
- **Console artifact jail**: run IDs, reports, screenshots, and preview targets are resolved beneath the configured runs root; screenshot names are additionally jailed beneath each `screenshots/` directory.
- **Single preview owner**: the console keeps at most one long-lived Vite preview and stops it when another run is opened or the server shuts down.

## Extension points (post-MVP)

- `providers/`: add vision-capable calls for screenshot input (Phase 3).
- `reviewer`: add coarse screenshot-vs-reference comparison.
- `runner`: per-interaction Playwright scripts (click flows) instead of static shots.
