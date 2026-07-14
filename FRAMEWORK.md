# Vibe-one Framework

## 当前产品基线

Vibe-one 当前不是 CLI-only 代码生成器，而是一个本地 `Product Studio + 成品质量流水线`：

- Focus 把产品目标、目标用户、核心流程、视觉方向和参考图 storyboard 合成为统一 brief。
- Planner 输出可执行 `productDesign`、页面、场景、acceptance criteria 和可选参考图映射。
- Builder 受 12 文件 / 约 24,000 字符、固定脚手架、依赖白名单和路径 jail 约束。
- 桌面/移动 UI audit 检查 overflow、44px、WCAG AA、语义层级、内容和核心状态。
- 首次全绿后只执行一次隔离 polish candidate；候选全量复验后才能提升为最终 app。
- Flow 用生产时间线、作品画布和 Quality Inspector 回放安全的规格、质量和交付证据。

当前只生成响应式 React + Vite Web 产品。远程托管、认证、多用户、并发任务、持久化凭证和无界 repair/polish 不在范围内。

## English Summary

Vibe-one is a bounded local AI product-delivery system. Models generate product specifications and source files; deterministic local build, interaction, UI-quality, and optional visual checks decide success. A single isolated polish candidate is promoted only after complete re-verification.

## Project Positioning

Vibe-one is a hands-off app replication project for portfolio use. It is not another manually built app. Its purpose is to prove that an AI-assisted workflow can turn a target product brief or UI reference into a runnable app artifact with measurable automation, verification, repair, and delivery evidence.

The short version:

```text
target brief / screenshots -> generated spec -> generated app -> local verification -> repair loop -> delivery report
```

The project should demonstrate engineering judgment, not just AI-generated code. The strongest interview claim is:

> I built a bounded AI delivery pipeline that can analyze an app target, generate a runnable clone, verify it with local commands and screenshots, repair failures, and produce an auditable report.

## Why API Access Is Required

True hands-off automation requires programmatic model calls. A manual Codex or Cursor session can help build the tool, but it cannot itself be the tool's core evidence.

Minimum viable API setup:

- One OpenAI-compatible chat endpoint.
- A vision-capable OpenAI-compatible model when reference screenshots are supplied.
- Local filesystem write operations controlled by the orchestrator.
- Local command execution for install, build, test, and screenshot capture.
- Token and cost tracking from API usage metadata when available.

Do not start with multi-provider routing, vector databases, cloud queues, GitHub Apps, or a full agent platform. Those are second-stage features.

## Core User Story

As a portfolio evaluator, I can give Vibe-one a small app target and see it produce:

- `SPEC.generated.md`: what the system believes it needs to build.
- A runnable generated app.
- Playwright screenshots of the generated result.
- `DELIVERY_REPORT.md`: commands run, failures, repair attempts, token/cost usage, and final status.

The evaluator should not need to trust a claim. They should be able to inspect the files and run the demo.

## MVP Scope

The first version should support a single frontend stack and a narrow app type.

Recommended MVP:

- Target stack: React + Vite or Expo Web.
- Input type: text-only, screenshot-only, or combined text and reference screenshots.
- Output type: static or mock-data mobile-style app.
- Verification: `npm install`, `npm run build`, local preview, Playwright screenshot.
- Repair loop: at most two automated fix attempts per run.
- Report: generated Markdown with exact commands, result states, and model usage.

MVP non-goals:

- Native iOS/Android builds.
- Real backend integration.
- Production auth, payment, push, maps, media upload, or live database.
- Perfect pixel-level cloning.
- Multi-agent consensus or Raft-like orchestration.

## Architecture

### 1. Input Layer

Accepts target material:

- `input/brief.md`: product goal, pages, style, and constraints.
- `input/screenshots/`: optional screenshots for visual guidance.
- `input/constraints.json`: stack choice, target viewport, max repair rounds, and model config.

Reference inputs accept PNG/JPEG/WebP, up to 4 files, 6 MiB each and 18 MiB total. The console additionally bounds the complete request body to 26 MiB. References are normalized into sanitized files plus metadata before planning.

### 2. Planner

Reads the input and generates:

- App summary.
- Page list.
- Component list.
- Data model.
- Interaction list.
- Acceptance criteria.
- Visual direction and explicit page-to-reference mapping when images are present.

Output:

- `runs/<run-id>/SPEC.generated.md`
- `runs/<run-id>/PLAN.generated.md`

### 3. Builder

Turns the generated plan into a runnable project.

Responsibilities:

- Create app files.
- Generate mock data.
- Generate routes/components/styles.
- Keep the project small enough to inspect.
- Avoid hidden one-off magic.

Output:

- `runs/<run-id>/app/`

### 4. Runner

Executes local verification commands.

Minimum commands:

```text
npm install
npm run build
npm run preview
playwright screenshot
```

The runner captures stdout, stderr, exit codes, timing, and generated screenshots.

Output:

- `runs/<run-id>/logs/`
- `runs/<run-id>/screenshots/`

### 5. Reviewer

Checks whether the generated app satisfies the target.

Implemented checks:

- Build passes.
- Preview server starts.
- Screenshot is non-empty.
- Expected page text exists.
- Expected number of pages/routes exists.
- Reference/output comparison using local SSIM-derived structure and RGB color-histogram scores.
- A configurable visual threshold (`0.62` by default) with per-page, per-round evidence.

The threshold is a coarse visual-consistency gate, not pixel-perfect cloning. The model supplies the visual spec and mapping; it does not grade its own output.

### 6. Fixer

If verification fails, sends a compact failure report back to the model and asks for a patch.

Repair loop rules:

- Keep max repair rounds small.
- Record each failure and patch attempt.
- Stop instead of looping forever.
- Do not claim success unless verification passes.
- Feed failed visual comparison evidence to the visual fixer and retain every bounded repair round.

### 7. Reporter

Creates a final delivery artifact.

Output:

- `runs/<run-id>/DELIVERY_REPORT.md`

The report should include:

- Input summary.
- Model used.
- Token/cost usage if available.
- Commands executed.
- Build/test/screenshot status.
- Repair rounds.
- Final screenshots.
- Known gaps.
- Human review notes.

## Repository Layout

Target structure:

```text
Vibe-one/
  FRAMEWORK.md
  README.md
  history.md
  package.json
  src/
    cli/
    core/
    providers/
    runner/
    reporter/
  examples/
    expense-mobile/
      input/
    notes-mobile/
      input/
  runs/
    .gitkeep
  docs/
    architecture.md
    interview-positioning.md
```

The initial framework document can exist before code. Once implementation starts, `README.md` should become the runnable entry point and `FRAMEWORK.md` should stay as the product boundary.

## Demo Targets

Use small apps that are visually clear and easy to verify.

Good first targets:

- Mobile expense tracker.
- Habit tracker.
- Notes/bookmark manager.
- Local life merchant dashboard.

Avoid first:

- Full Xiaohongshu/TikTok clones.
- Real-time chat.
- Payment systems.
- Full ecommerce flows.
- Native-only apps.

## Interview Bar

Weak claim:

> I used AI to build an app.

Acceptable claim:

> I built a demo app with AI assistance and documented the prompts.

Strong claim:

> I built a small hands-off app replication pipeline. It takes a brief, generates a spec and app, runs build/screenshot verification, performs bounded repair, and emits a delivery report with token/cost and failure evidence.

The project is considered interview-ready when it has:

- Two successful demo runs.
- One failed-then-repaired demo run.
- Reproducible local commands.
- Clear generated reports.
- Screenshots included in the repo or README.
- A concise explanation of why API-based automation is different from manual AI editing.

### Current evidence (2026-07-10)

The interview bar above is satisfied for the text-brief scope:

- Expense tracker: real-model success on round 0, with 3 pages and 4 interaction scenarios.
- Notes app: real-model success after repair round 1, with the diagnosis and patched file retained.
- Eight generated screenshots and both Delivery Reports are committed under `docs/`.
- Local unit tests and opt-in npm/Vite/Playwright e2e tests are reproducible without API quota.

## Implementation Phases

### Phase 0 - Documentation

- Create this framework.
- Define project boundaries.
- Decide stack and first demo target.

### Phase 1 - Text-Brief MVP

- Implement a CLI that accepts `input/brief.md`.
- Call one OpenAI-compatible model.
- Generate `SPEC.generated.md`, `PLAN.generated.md`, and app files.
- Run build and screenshot.
- Generate `DELIVERY_REPORT.md`.

### Phase 2 - Repair Loop

- Capture build/runtime errors.
- Ask model for targeted fixes.
- Apply fixes.
- Re-run verification.
- Record all attempts.

### Phase 3 - Screenshot Input (implemented)

- Accept reference screenshots.
- Ask vision model or preprocessing step to extract UI structure.
- Compare generated screenshot with reference screenshot at a coarse level.

### Phase 4 - Portfolio Polish

- Add 2-3 demo case studies.
- Add README screenshots.
- Add interview explanation.
- Add limitations and failure analysis.

## Key Risks

- Scope creep into a generic coding agent.
- Spending too much time on visual scoring before the basic pipeline works.
- Claiming "hands-off" without API calls and automated verification.
- Building a huge app instead of a repeatable generator.
- Letting model-generated code pass without commands proving it runs.

## Current Decision

The Product Lab baseline supports text-only, screenshot-only, and combined inputs. Multimodal planning produces a structured product/visual spec; local deterministic comparison enforces coarse structure/color consistency; functional and visual repair remain bounded and auditable. Credentials are session-only, public APIs/artifacts omit secrets and base64 payloads, and private absolute input paths are never exposed.
