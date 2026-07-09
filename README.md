# Vibe-one

Bounded AI delivery pipeline: takes a product brief, generates a spec and a runnable React app, verifies it with real local commands and Playwright screenshots, repairs failures within a bounded loop, and emits an auditable delivery report.

```text
brief.md -> SPEC.generated.md -> runs/<id>/app/ -> npm build + preview + screenshots -> repair loop (max N) -> DELIVERY_REPORT.md
```

See `FRAMEWORK.md` for the product boundary and `docs/architecture.md` for module details.

## Quick start

```bash
npm install
npx playwright install chromium

# configure the model endpoint
set VIBE_ONE_API_KEY=sk-...            # required
set VIBE_ONE_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
set VIBE_ONE_MODEL=gpt-4o-mini

# full pipeline on the expense-tracker demo
npm run demo:expense

# planner only (no build, cheap smoke test of the model connection)
node src/cli/index.js plan examples/expense-mobile
```

Each run writes to `runs/<target>-<timestamp>/`:

| artifact | meaning |
| --- | --- |
| `SPEC.generated.md` / `PLAN.generated.md` | what the system decided to build |
| `app/` | the generated runnable app |
| `logs/` | full stdout/stderr per command + `events.jsonl` |
| `screenshots/` | Playwright captures per planned page |
| `DELIVERY_REPORT.md` | commands, exit codes, repair rounds, token usage, checks |

## Module map

```text
src/cli/        entry + arg parsing
src/core/       config, run context, pipeline, planner, builder, reviewer, fixer
src/providers/  single OpenAI-compatible chat provider (MVP: the only one)
src/runner/     command execution, preview server, Playwright screenshots
src/reporter/   DELIVERY_REPORT.md generation
```

## Design rules

- The reviewer is purely mechanical (exit codes, screenshot bytes, page text) so results are reproducible without trusting a model.
- The fixer loop is bounded by `maxRepairRounds` (default 2) and records every diagnosis + patched file.
- Model-written files are jailed to `runs/<id>/app/` (`safeJoin` rejects traversal).
- Success is only claimed when every reviewer check passes.

## Status

Phase 1 scaffold (text-brief MVP). Screenshot input and visual similarity scoring are Phase 3 - see `FRAMEWORK.md`.
