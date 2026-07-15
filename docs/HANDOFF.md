# Vibe-one Handoff (Fable5 -> Codex)

Status: **Product Studio quality redesign Tasks 1–15 and the Task 16 route-scoped state audit are complete; real showcase evidence is waiting on upstream inference recovery.**

## Current Product Studio handoff

Completed and pushed on `feat/product-studio-quality`:

- executable `productDesign`, 12-file / 24k builder contract, deterministic desktop/mobile UI audit;
- one isolated bounded polish candidate with full build/content/interaction/UI/visual re-verification;
- immutable design/quality/polish evidence APIs and referenced raster bundles;
- Focus structured brief + ordered storyboard;
- Flow production timeline + persistent page/device canvas + Quality Inspector;
- responsive mutually exclusive drawers, Escape/focus return, reduced motion and 44px targets;
- public-safe SignalDesk and Atlas Research representative inputs.

Task 16 preflight and the local quality pipeline are green. Required states now use an executable `{ name, trigger, route, steps, expectText }` contract: the collector navigates to each same-origin route, performs the Playwright actions, verifies visible state evidence on desktop and mobile, and no longer repeats the global state list across every default page snapshot. The default suite passes 114 tests with 19 opt-in skips; the full no-API run exercised all 11 production scenarios, and the corrected route-scoped polish scenario passed after updating its expected screenshot count.

Real showcase publication is still blocked externally. Earlier `gpt-5.5` SignalDesk output produced a valid four-file app and passed all 6/6 interaction scenarios, but that run predated the route-scoped audit. On 2026-07-15, two fresh SignalDesk attempts failed before Planner completion on upstream HTTP 503, and minimal probes for `gpt-5.5`, `gpt-5.6-luna`, and `gpt-5.6-sol` returned the same `Service temporarily unavailable` response. No failed report or screenshot is published as showcase success. When inference recovers, rerun SignalDesk first; only after it clears every gate should Atlas run.

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
6. Builder output retains the hard 12-file / 24,000-character contract, targets 18,000 characters and no more than six model-authored files, and passes a 6,000-token request cap when the gateway honors `max_tokens`.
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
