# Vibe-one Handoff (Fable5 -> Codex)

Status: **completed on 2026-07-10**.

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

No Phase 1/2 handoff item remains. The next product phase is Phase 3: reference screenshot input and coarse visual comparison. That work is intentionally outside this completed handoff and should preserve the safety and evidence contracts above.
