# Architecture

## 中文摘要 / Chinese Summary

Vibe-one 的核心不是“让模型写页面”，而是把生成放进一条可验证、可回放、有硬边界的交付链：Planner 产出可执行产品规格，Builder 只能在固定 React/Vite 脚手架和文件预算内写源码，Runner 用真实 npm/Vite/Playwright 运行结果取证，Reviewer 只相信本地机械证据，Fixer 根据失败证据做有限轮修复，Polisher 只能在隔离候选中做一次最小改动并接受全量复验。

安全边界包括固定 manifest/config、依赖白名单、`npm install --ignore-scripts`、模型路径 jail、同源预览路由、桌面/移动 UI audit、可选本地视觉分数、会话级凭证和不可变 evidence bundle。SignalDesk 已证明文字任务书路径可以真实交付；Atlas 的失败则证明视觉/UI gate 会拒绝未达标结果，而不是包装成成功。

## 当前流水线 / Current Pipeline

```text
Focus brief + normalized references
  -> Planner: productDesign + pages + scenarios + visual mapping
  -> Builder: fixed React/Vite scaffold + bounded model files
  -> Runner: build + preview + desktop/mobile Playwright evidence
  -> Reviewer: content + interaction + deterministic UI audit
  -> Visual gate: local structure/color score when references exist
  -> bounded repair until first all-green draft
  -> isolated single-pass polish candidate
  -> full re-verification
  -> immutable evidence bundle + bilingual Delivery Report
```

Product Studio keeps browser concerns separated: `studio-state.js` is the pure replay reducer, `studio-renderers.js` owns timeline/Inspector DOM rendering, and `app.js` retains fetch, EventSource, preview lifecycle, device/page selection and drawer interaction ownership.

## Data flow

```text
brief + normalized references + constraints
        |
        v
   [Planner] --multimodal model--> product + visual spec --> SPEC.generated.md / PLAN.generated.md
        |
        v
   [Builder] --model--> delimited file blocks --> runs/<id>/app/   (safeJoin path jail)
        |
        v
   [Runner]  npm install -> npm run build -> vite preview -> Playwright screenshots
        |
        v
   [Reviewer] mechanical checks + local SSIM/color-histogram visual gate
        |                                   |
        | pass                              | fail (round < maxRepairRounds)
        v                                   v
   [Reporter]                  [functional / visual fixer] --model--> patched files --> back to Runner
```

## Module contracts

| module | input | output | model calls |
| --- | --- | --- | --- |
| `core/config.js` | targetDir | merged config (constraints > env > defaults) | 0 |
| `providers/openaiCompatible.js` | system + user prompts | streamed or JSON chat result + usage | 1 per request |
| `core/planner.js` | brief + optional references | structured product/visual spec + markdown artifacts | 1 |
| `core/builder.js` | brief + spec | fixed scaffold (package.json/vite.config) + model files under `app/` | 1 |
| `runner/commands.js` | appDir | command records + screenshots + page text + scenario results | 0 |
| `core/reviewer.js` | runner results + spec | `{ pass, checks[], failed[] }` incl. mustContain + scenarios | 0 |
| `core/fixer.js` | failure evidence | patched files + diagnosis | 1 per round |
| `runner/visualCompare.js` | mapped reference + generated screenshot | deterministic SSIM structure, color histogram, combined score | 0 |
| `core/fixer.js` (visual mode) | failed visual evidence + current source | patched files + visual diagnosis | 1 per visual round |
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

The console calls `runPipeline()` in process. It accepts text-only, screenshot-only, or combined input. PNG/JPEG/WebP references are limited to 4 files, 6 MiB each, 18 MiB total; the JSON request body is capped at 26 MiB. `runContext.logEvent()` persists each event to `events.jsonl` before mirroring it to the job manager, so browser delivery never replaces the durable audit trail.

Visual evidence is written to `runs/<id>/visual/comparisons.json`: each round records reference/output mapping, score, structure/color subscores, threshold and pass/fail. The delivery report and repair records retain the bounded fixer trail. The default `0.62` threshold measures coarse visual consistency, not pixel-perfect cloning.

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
- **Session-only secret**: browser-entered API keys stay in process memory, are removed from public job objects, and are never written into console inputs or run artifacts. Uploaded base64 exists only at the bounded request boundary; persisted manifests/public APIs contain metadata and jailed file URLs, not base64 or private absolute paths.
- **Console artifact jail**: run IDs, reports, screenshots, and preview targets are resolved beneath the configured runs root; screenshot names are additionally jailed beneath each `screenshots/` directory.
- **Single preview owner**: the console keeps at most one long-lived Vite preview and stops it when another run is opened or the server shuts down.

## Extension points (post-MVP)

- Add finer typography/spacing analysis without replacing the deterministic gate with model self-grading.
- Add more generated-app stacks only with equivalent scaffold, dependency, and path controls.
