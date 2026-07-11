# Vibe-one Handoff (Fable5 -> Codex)

Status: **Product Lab visual-input phase completed on 2026-07-11**.

The original handoff asked Codex to capture a successful real run, prove a second demo, retain one failed-then-repaired report, and add screenshots to the repository. All four requirements now have committed evidence.

## Completion evidence

| requirement | evidence |
| --- | --- |
| Successful real expense run | `docs/demo-reports/expense-mobile.md` |
| Second real demo | `docs/demo-reports/notes-mobile-repaired.md` |
| Failed-then-repaired run | Notes report: repair round 1 patched `src/App.jsx`, then all checks passed |
| Screenshots in repository | `docs/screenshots/expense-*.png` and `docs/screenshots/notes-*.png` |

Both runs used `gpt-5.6-sol` through a configured OpenAI-compatible endpoint. The public evidence intentionally omits the endpoint and all credentials.

## Real-run fixes completed

1. Builder and fixer keep the delimiter file protocol. Source files are never transported as JSON strings.
2. Fixer receives the current generated source before producing complete-file patches.
3. Provider retries bounded network errors, 429 responses, and transient HTTP 500/502/503/504 responses.
4. Chat completions stream by default and fall back to ordinary JSON responses when a gateway ignores streaming.
5. Streaming uses a separate 10-minute default timeout so an active long response is not aborted by the 120-second non-streaming limit.
6. Builder output is constrained to an MVP budget of at most 8 files and roughly 12,000 characters.
7. Planner-only runs exit with code 0 when their status is `planned`.
8. Windows e2e tests canonicalize 8.3 temporary directory aliases before invoking Vite/Rollup.

## Verified contracts

- Fixed trusted `package.json` and Vite config.
- Dependency whitelist plus `npm install --ignore-scripts`.
- Model file writes jailed by `safeJoin`.
- Mechanical reviewer with page text and interaction scenarios.
- Bounded repair rounds with diagnosis and patched files in the report.
- Free preview ports and process-tree cleanup.
- Offline unit suite plus opt-in full e2e suite.

## Remaining boundary

The local Product Lab now accepts text-only, screenshot-only, and combined input. PNG/JPEG/WebP references are bounded to 4 files, 6 MiB each and 18 MiB total; the console request body is capped at 26 MiB. An OpenAI-compatible multimodal planner produces a structured product/visual spec and page mapping. Generated screenshots then pass through deterministic local SSIM structure and RGB histogram scoring, followed by bounded visual repair when needed. The default `0.62` threshold means coarse visual consistency, not pixel-perfect cloning.

Evidence is available in the Product Lab reference, screenshot, visual-comparison and repair tabs, and on disk under `runs/<id>/references/`, `runs/<id>/screenshots/`, `runs/<id>/visual/comparisons.json`, and `runs/<id>/DELIVERY_REPORT.md`.

Credentials remain session-only. Public job data and persisted artifacts do not expose API keys, uploaded base64, or private absolute input paths. Remote hosting/authentication, concurrent jobs, durable credentials, and mid-command cancellation remain outside the local-console boundary.
