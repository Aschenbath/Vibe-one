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
| `core/planner.js` | brief | spec JSON + 2 markdown artifacts | 1 |
| `core/builder.js` | brief + spec | files written under `app/` | 1 |
| `runner/commands.js` | appDir | command records + screenshots + page text | 0 |
| `core/reviewer.js` | runner results + spec | `{ pass, checks[], failed[] }` | 0 |
| `core/fixer.js` | failure evidence | patched files + diagnosis | 1 per round |
| `reporter/deliveryReport.js` | run context + results | `DELIVERY_REPORT.md` | 0 |

## Safety boundaries

- **Path jail**: every model-provided path passes `safeJoin(appDir, path)`; absolute paths and `..` traversal throw.
- **Bounded repair**: at most `maxRepairRounds` fixer calls; exhaustion is recorded, never retried silently.
- **Command timeouts**: each spawned command has a hard timeout and is `SIGKILL`ed past it.
- **Honest status**: `success` requires the mechanical reviewer to pass; fatal errors land in the report under "Fatal error".
- **Token accounting**: every chat call's `usage` is accumulated on the run context and printed in the report.

## Extension points (post-MVP)

- `providers/`: add vision-capable calls for screenshot input (Phase 3).
- `reviewer`: add coarse screenshot-vs-reference comparison.
- `runner`: per-interaction Playwright scripts (click flows) instead of static shots.
