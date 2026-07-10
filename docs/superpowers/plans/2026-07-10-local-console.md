# Vibe-one Local Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser control plane that runs the existing Vibe-one pipeline from a brief, streams progress, preserves run history, and previews successful generated apps without persisting secrets.

**Architecture:** Add a framework-free Node HTTP/SSE layer under `src/console/`. A single in-process job manager calls `runPipeline`, receives mirrored run-context events, and exposes sanitized job state. A run store reads persisted evidence, while a preview manager owns at most one Vite preview process.

**Tech Stack:** Node.js ESM, built-in `node:http`, built-in `node:test`, existing Playwright dependency, HTML/CSS/vanilla JavaScript.

---

## File Map

- Modify `src/core/runContext.js`: mirror persisted events to an optional callback.
- Modify `src/core/config.js`: accept an in-memory API-key override without changing CLI behavior.
- Create `src/console/errors.js`: typed HTTP-safe errors.
- Create `src/console/jobManager.js`: session configuration, job validation, one-active-job state, pipeline invocation, and event subscriptions.
- Create `src/console/runStore.js`: persisted run discovery and jailed artifact access.
- Create `src/console/previewManager.js`: one-preview lifecycle over the existing runner.
- Create `src/console/http.js`: bounded JSON parsing and response helpers.
- Create `src/console/server.js`: route dispatch, SSE, static assets, startup, and shutdown.
- Create `src/console/index.js`: executable console entry.
- Create `src/console/public/index.html`: accessible workstation markup.
- Create `src/console/public/app.css`: responsive industrial-workstation presentation.
- Create `src/console/public/app.js`: form, history, SSE, evidence, and preview behavior.
- Create `test/console.test.js`: offline unit/integration contracts.
- Create `test/console-e2e.test.js`: opt-in Playwright GUI smoke test.
- Create `scripts/run-console-e2e.js`: cross-platform opt-in test launcher.
- Modify `package.json`: add `console` and `test:console:e2e` scripts.
- Modify `README.md`, `docs/architecture.md`, and `history.md`: document the product GUI and completion evidence.

### Task 1: Event Bridge And In-Memory Credential Override

**Files:**
- Modify: `src/core/runContext.js`
- Modify: `src/core/config.js`
- Test: `test/core.test.js`

- [ ] **Step 1: Write failing event and credential tests**

Add imports and tests to `test/core.test.js`:

```js
import { createRunContext } from '../src/core/runContext.js';
import { loadConfig } from '../src/core/config.js';

test('run context mirrors persisted events to an optional listener', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-events-'));
  const seen = [];
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
    onEvent: (event) => seen.push(event),
  });
  await ctx.logEvent('plan:start', { summary: 'planning' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'plan:start');
  const persisted = await fs.readFile(path.join(ctx.logsDir, 'events.jsonl'), 'utf8');
  assert.match(persisted, /"type":"plan:start"/);
  await fs.rm(root, { recursive: true, force: true });
});

test('loadConfig accepts an in-memory API key without persisting it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-config-'));
  await fs.mkdir(path.join(root, 'input'), { recursive: true });
  await fs.writeFile(path.join(root, 'input', 'brief.md'), '# Demo');
  const config = await loadConfig(root, { apiKey: 'session-secret' });
  assert.equal(config.apiKey, 'session-secret');
  assert.doesNotMatch(await fs.readFile(path.join(root, 'input', 'brief.md'), 'utf8'), /session-secret/);
  await fs.rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/core.test.js`

Expected: FAIL because `loadConfig` ignores its second argument and `createRunContext` does not invoke `onEvent`.

- [ ] **Step 3: Implement the minimal contracts**

Change the config signature and key lookup in `src/core/config.js`:

```js
export async function loadConfig(targetDir, overrides = {}) {
  const apiKey = overrides.apiKey || process.env.VIBE_ONE_API_KEY;
  if (!apiKey) throw new Error('VIBE_ONE_API_KEY is not set (see .env.example)');
  return { ...DEFAULTS, ...constraints, apiKey, brief, inputDir };
}
```

Mirror events only after durable append succeeds in `src/core/runContext.js`:

```js
async function logEvent(type, data = {}) {
  const event = { ts: new Date().toISOString(), type, ...data };
  events.push(event);
  await fs.appendFile(eventLogPath, JSON.stringify(event) + '\n', 'utf8');
  config.onEvent?.(event);
  console.log(`[${type}]`, data.summary ?? '');
}
```

- [ ] **Step 4: Verify GREEN and the existing offline suite**

Run: `node --test test/core.test.js`

Expected: all core tests pass.

Run: `npm test`

Expected: all offline tests pass and existing e2e tests remain skipped.

- [ ] **Step 5: Commit**

```bash
git add src/core/runContext.js src/core/config.js test/core.test.js
git commit -m "feat: expose pipeline events to local clients"
```

### Task 2: Single-Job Manager And Secret-Safe Session State

**Files:**
- Create: `src/console/errors.js`
- Create: `src/console/jobManager.js`
- Create: `test/console.test.js`

- [ ] **Step 1: Write failing job-manager tests**

Create `test/console.test.js` with these initial contracts:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobManager } from '../src/console/jobManager.js';

test('session status exposes key presence but never the key', () => {
  const manager = createJobManager({ runsRoot: '/tmp/runs', pipeline: async () => {} });
  manager.setSessionConfig({ apiKey: 'top-secret', baseUrl: 'https://example.test/v1', model: 'demo' });
  const status = manager.getStatus();
  assert.equal(status.hasApiKey, true);
  assert.equal(JSON.stringify(status).includes('top-secret'), false);
});

test('a job streams stages and rejects concurrent starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-job-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pipeline = async ({ config }) => {
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:start', summary: 'planning' });
    await gate;
    config.onEvent({ ts: new Date().toISOString(), type: 'report:written', summary: 'report' });
    return { runId: 'demo-run', runDir: path.join(root, 'runs', 'demo-run'), status: 'success' };
  };
  const manager = createJobManager({ runsRoot: path.join(root, 'runs'), pipeline });
  manager.setSessionConfig({ apiKey: 'secret' });
  const first = await manager.startJob({ title: 'Demo', brief: '# Demo', mode: 'run' });
  await assert.rejects(
    manager.startJob({ title: 'Second', brief: '# Second', mode: 'run' }),
    (error) => error.code === 'JOB_ACTIVE',
  );
  release();
  await manager.waitForJob(first.id);
  const finished = manager.getJob(first.id);
  assert.equal(finished.status, 'success');
  assert.equal(finished.events[0].type, 'plan:start');
  assert.equal(JSON.stringify(finished).includes('secret'), false);
  await fs.rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the new suite and verify RED**

Run: `node --test test/console.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/console/jobManager.js`.

- [ ] **Step 3: Add typed errors**

Create `src/console/errors.js`:

```js
export class ConsoleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.status = status;
  }
}
```

- [ ] **Step 4: Implement the job manager**

Create `src/console/jobManager.js` with this public surface:

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPipeline } from '../core/pipeline.js';
import { loadConfig } from '../core/config.js';
import { ConsoleError } from './errors.js';

const TERMINAL = new Set(['success', 'failed', 'planned']);

export function createJobManager({ runsRoot, pipeline = runPipeline, load = loadConfig, env = process.env }) {
  const jobs = new Map();
  const subscribers = new Map();
  const session = { apiKey: '', baseUrl: '', model: '' };
  let activeJobId = null;

  function setSessionConfig(next = {}) {
    for (const key of ['apiKey', 'baseUrl', 'model']) {
      if (Object.hasOwn(next, key)) session[key] = String(next[key] ?? '').trim();
    }
    return getStatus();
  }

  function getStatus() {
    return {
      ready: true,
      hasApiKey: Boolean(session.apiKey || env.VIBE_ONE_API_KEY),
      baseUrl: session.baseUrl || env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1',
      model: session.model || env.VIBE_ONE_MODEL || 'gpt-4o-mini',
      activeJobId,
    };
  }

  async function startJob(input) {
    if (activeJobId) throw new ConsoleError('JOB_ACTIVE', 'Another job is already running.', 409);
    const brief = String(input.brief ?? '').trim();
    if (!brief) throw new ConsoleError('BRIEF_REQUIRED', 'Describe the app before starting.', 422);
    if (brief.length > 100_000) throw new ConsoleError('BRIEF_TOO_LARGE', 'Briefs are limited to 100,000 characters.', 413);
    const mode = input.mode === 'plan' ? 'plan' : input.mode === 'run' ? 'run' : null;
    if (!mode) throw new ConsoleError('MODE_INVALID', 'Mode must be run or plan.', 422);
    const apiKey = session.apiKey || env.VIBE_ONE_API_KEY;
    if (!apiKey) throw new ConsoleError('API_KEY_REQUIRED', 'Enter an API key for this session.', 422);

    const id = randomUUID();
    const title = String(input.title ?? 'Untitled app').trim().slice(0, 80) || 'Untitled app';
    const targetDir = path.join(runsRoot, '.console-inputs', id);
    const baseUrl = String(input.baseUrl || session.baseUrl || env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1');
    const model = String(input.model || session.model || env.VIBE_ONE_MODEL || 'gpt-4o-mini');
    await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief, 'utf8');
    await fs.writeFile(path.join(targetDir, 'input', 'constraints.json'), JSON.stringify({ model, baseUrl }, null, 2), 'utf8');

    const job = { id, title, mode, model, baseUrl, status: 'queued', stage: 'queued', createdAt: new Date().toISOString(), completedAt: null, runId: null, runDir: null, events: [] };
    jobs.set(id, job);
    activeJobId = id;
    job.promise = execute(job, { targetDir, apiKey });
    return publicJob(job);
  }

  async function execute(job, { targetDir, apiKey }) {
    try {
      const config = await load(targetDir, { apiKey });
      config.runsRoot = runsRoot;
      config.onEvent = (event) => acceptEvent(job, event);
      const result = await pipeline({ targetDir, config, planOnly: job.mode === 'plan' });
      job.status = result.status;
      job.stage = result.status;
      job.runId = result.runId;
      job.runDir = result.runDir;
    } catch (error) {
      job.status = 'failed';
      job.stage = 'failed';
      acceptEvent(job, { ts: new Date().toISOString(), type: 'fatal', summary: error.message });
    } finally {
      job.completedAt = new Date().toISOString();
      activeJobId = null;
      publish(job);
    }
  }

  function acceptEvent(job, event) {
    const clean = { ts: event.ts, type: event.type, summary: String(event.summary ?? ''), ...(event.name ? { name: event.name } : {}) };
    job.events.push(clean);
    job.stage = stageForEvent(clean.type, job.stage);
    publish(job, clean);
  }

  function subscribe(id, listener) {
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(listener);
    return () => subscribers.get(id)?.delete(listener);
  }

  function publish(job, event = null) {
    for (const listener of subscribers.get(job.id) ?? []) listener(event, publicJob(job));
  }

  function getJob(id) { return jobs.has(id) ? publicJob(jobs.get(id), true) : null; }
  function listLiveJobs() { return [...jobs.values()].map((job) => publicJob(job)); }
  function waitForJob(id) { return jobs.get(id)?.promise ?? Promise.resolve(); }

  return { setSessionConfig, getStatus, startJob, getJob, listLiveJobs, waitForJob, subscribe };
}

function stageForEvent(type, current) {
  if (type.startsWith('plan:')) return 'planning';
  if (type.startsWith('build:')) return 'building';
  if (type.startsWith('fix:') || type.startsWith('repair:')) return 'repairing';
  if (['cmd:start', 'cmd:done', 'preview:start', 'preview:ready', 'screenshot', 'scenario', 'review'].includes(type)) return 'verifying';
  if (type === 'fatal') return 'failed';
  return current;
}

function publicJob(job, includeEvents = false) {
  return {
    id: job.id, title: job.title, mode: job.mode, model: job.model, baseUrl: job.baseUrl,
    status: job.status, stage: job.stage, createdAt: job.createdAt, completedAt: job.completedAt,
    runId: job.runId, hasReport: Boolean(job.runDir),
    ...(includeEvents ? { events: [...job.events] } : {}),
  };
}
```

- [ ] **Step 5: Verify GREEN and secret absence**

Run: `node --test test/console.test.js`

Expected: both tests pass.

Run: `rg -n "top-secret|session-secret" runs src test --glob '!test/*.test.js'`

Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/console/errors.js src/console/jobManager.js test/console.test.js
git commit -m "feat: manage local console jobs"
```

### Task 3: Persisted Run Store And Artifact Jail

**Files:**
- Create: `src/console/runStore.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Add failing run-store tests**

```js
import { createRunStore } from '../src/console/runStore.js';

test('run store reconstructs evidence and rejects traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-store-'));
  const runDir = path.join(root, 'demo-2026-07-10T12-00-00');
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'logs', 'events.jsonl'), '{"ts":"2026-07-10T12:00:00Z","type":"fix:applied","summary":"repair round 1"}\n');
  await fs.writeFile(path.join(runDir, 'DELIVERY_REPORT.md'), '# Delivery Report\n- Status: **success**\n- Model: demo @ local\n');
  await fs.writeFile(path.join(runDir, 'screenshots', 'home.png'), 'png');
  const store = createRunStore(root);
  const [summary] = await store.listRuns();
  assert.equal(summary.id, path.basename(runDir));
  assert.equal(summary.status, 'success');
  assert.equal(summary.repairCount, 1);
  assert.deepEqual((await store.getRun(summary.id)).screenshots, ['home.png']);
  await assert.rejects(store.readScreenshot(summary.id, '../DELIVERY_REPORT.md'), /outside/i);
  await fs.rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/console.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `runStore.js`.

- [ ] **Step 3: Implement the store**

Create `src/console/runStore.js` exporting `createRunStore(runsRoot)`. Implement `listRuns()`, `getRun(id)`, `getPreviewTarget(id)`, `readReport(id)`, `readScreenshot(id, name)`, and internal `resolveRunDir(id)`. Use `fs.readdir({ withFileTypes: true })`, ignore names beginning with `.`, parse `events.jsonl` line-by-line, derive status/model from `DELIVERY_REPORT.md`, and enforce:

```js
function jailed(root, ...parts) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new ConsoleError('PATH_OUTSIDE_RUNS', 'Requested artifact is outside the runs directory.', 400);
  }
  return resolved;
}
```

Return public run objects with `id`, `title`, `status`, `stage`, `model`, `createdAt`, `completedAt`, `repairCount`, `screenshots`, `events`, `hasReport`, and `previewEligible`. Never include absolute filesystem paths in these objects. `getPreviewTarget(id)` is server-internal and returns exactly `{ id, status, appDir }`, where `appDir` is the jailed `<run>/app` path.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/console.test.js`

Expected: all console tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/console/runStore.js test/console.test.js
git commit -m "feat: expose persisted run evidence safely"
```

### Task 4: Preview Lifecycle

**Files:**
- Create: `src/console/previewManager.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Add failing lifecycle tests**

```js
import { createPreviewManager } from '../src/console/previewManager.js';

test('preview manager reuses one preview and stops it on replacement', async () => {
  const stopped = [];
  let calls = 0;
  const manager = createPreviewManager({
    start: async (ctx) => {
      calls += 1;
      const id = calls;
      return { url: `http://127.0.0.1:${4100 + id}/`, stop: () => stopped.push(id) };
    },
  });
  const a = await manager.open({ id: 'a', status: 'success', appDir: '/tmp/a/app' });
  assert.deepEqual(await manager.open({ id: 'a', status: 'success', appDir: '/tmp/a/app' }), a);
  await manager.open({ id: 'b', status: 'success', appDir: '/tmp/b/app' });
  assert.deepEqual(stopped, [1]);
  manager.close();
  assert.deepEqual(stopped, [1, 2]);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/console.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `previewManager.js`.

- [ ] **Step 3: Implement preview ownership**

Create `src/console/previewManager.js`:

```js
import { startPreview } from '../runner/commands.js';
import { ConsoleError } from './errors.js';

export function createPreviewManager({ start = startPreview } = {}) {
  let active = null;
  async function open(run) {
    if (run.status !== 'success') throw new ConsoleError('PREVIEW_UNAVAILABLE', 'Only successful full runs can be previewed.', 409);
    if (active?.id === run.id) return { id: active.id, url: active.url };
    active?.stop();
    const preview = await start({ appDir: run.appDir, logEvent: async () => {} });
    active = { id: run.id, url: preview.url, stop: preview.stop };
    return { id: active.id, url: active.url };
  }
  function state(id) { return active?.id === id ? { active: true, url: active.url } : { active: false, url: null }; }
  function close() { active?.stop(); active = null; }
  return { open, state, close };
}
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/console.test.js`

Expected: all console tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/console/previewManager.js test/console.test.js
git commit -m "feat: manage generated app previews"
```

### Task 5: HTTP API, SSE, And Static Server

**Files:**
- Create: `src/console/http.js`
- Create: `src/console/server.js`
- Create: `src/console/index.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Add failing HTTP tests**

Add a `startTestServer()` helper and verify:

```js
import { createConsoleServer } from '../src/console/server.js';

test('HTTP API configures a session and starts a job without exposing the key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-http-'));
  const pipeline = async ({ config }) => {
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:start', summary: 'planning' });
    return { runId: 'run-1', runDir: path.join(root, 'runs', 'run-1'), status: 'planned' };
  };
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), pipeline });
  const address = await app.listen(0);
  const configResponse = await fetch(`${address.url}api/session/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'http-secret' }),
  });
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.text()).includes('http-secret'), false);
  const jobResponse = await fetch(`${address.url}api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Demo', brief: '# Demo', mode: 'plan' }),
  });
  assert.equal(jobResponse.status, 202);
  assert.equal((await jobResponse.text()).includes('http-secret'), false);
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('HTTP API returns structured validation errors and bounded bodies', async () => {
  const app = createConsoleServer({ runsRoot: path.join(os.tmpdir(), 'vibe-http-errors') });
  const address = await app.listen(0);
  const response = await fetch(`${address.url}api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: '', mode: 'run' }),
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: { code: 'BRIEF_REQUIRED', message: 'Describe the app before starting.' } });
  await app.close();
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/console.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server.js`.

- [ ] **Step 3: Implement HTTP helpers**

Create `src/console/http.js` with `readJson(req, { maxBytes = 1_000_000 })`, `sendJson(res, status, body)`, `sendText(res, status, text, type)`, and `sendError(res, error)`. `readJson` must destroy oversized requests and throw `ConsoleError('BODY_TOO_LARGE', ..., 413)`. `sendError` must expose only `ConsoleError.message`; unexpected errors become `INTERNAL_ERROR` with a generic message.

- [ ] **Step 4: Implement routes and SSE**

Create `src/console/server.js` exporting:

```js
export function createConsoleServer({ host = '127.0.0.1', runsRoot = resolveRunsRoot(), pipeline, previewStart } = {})
```

Construct `jobManager`, `runStore`, and `previewManager`. Route exact paths with `new URL(req.url, 'http://localhost')`; support the API from the design spec. For SSE:

```js
res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
});
for (const event of job.events) res.write(`data: ${JSON.stringify({ event, job })}\n\n`);
const unsubscribe = jobs.subscribe(id, (event, nextJob) => {
  res.write(`data: ${JSON.stringify({ event, job: nextJob })}\n\n`);
  if (['success', 'failed', 'planned'].includes(nextJob.status)) res.end();
});
req.on('close', unsubscribe);
```

The preview route must call `runStore.getPreviewTarget(id)` before `previewManager.open(target)`. The returned absolute `appDir` is never serialized into the HTTP response.

Serve only `index.html`, `app.css`, and `app.js` from `src/console/public`; unknown frontend routes fall back to `index.html`, while unknown `/api/` routes return JSON 404.

Return `{ listen(port = 4174), close() }`. `listen` resolves `{ host, port, url }`, and `close` closes SSE responses, the preview manager, and the HTTP server.

- [ ] **Step 5: Add the executable**

Create `src/console/index.js`:

```js
#!/usr/bin/env node
import { createConsoleServer } from './server.js';

const app = createConsoleServer();
const address = await app.listen(Number(process.env.VIBE_ONE_CONSOLE_PORT) || 4174);
console.log(`Vibe-one console: ${address.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await app.close(); process.exit(0); });
}
```

- [ ] **Step 6: Verify GREEN**

Run: `node --test test/console.test.js`

Expected: all HTTP and prior console tests pass with no open-handle warning.

- [ ] **Step 7: Commit**

```bash
git add src/console/http.js src/console/server.js src/console/index.js test/console.test.js
git commit -m "feat: serve the local console API"
```

### Task 6: Production-Grade Console Interface

**Files:**
- Create: `src/console/public/index.html`
- Create: `src/console/public/app.css`
- Create: `src/console/public/app.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Add failing static-interface contracts**

```js
test('console page exposes the complete operational workflow', async () => {
  const app = createConsoleServer({ runsRoot: path.join(os.tmpdir(), 'vibe-console-ui') });
  const address = await app.listen(0);
  const html = await (await fetch(address.url)).text();
  assert.match(html, /id="brief"/);
  assert.match(html, /id="launch-run"/);
  assert.match(html, /id="run-history"/);
  assert.match(html, /id="event-log"/);
  assert.match(html, /id="evidence-pane"/);
  assert.match(html, /id="preview-frame"/);
  await app.close();
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/console.test.js`

Expected: FAIL because the public assets do not exist.

- [ ] **Step 3: Create accessible markup**

Create `index.html` with a `header`, `aside` history rail, `main` workspace, and evidence `section`. Include labeled fields `title`, `brief`, `base-url`, `model`, `api-key`; a radio-backed segmented mode control; buttons `save-session`, `clear-key`, `launch-run`, `new-run`, and `launch-preview`; tabs for Preview, Screenshots, Report, and Repairs; an `aria-live="polite"` status region; and a `<template id="history-item-template">` for repeated history rows. Load `/app.css` and `/app.js` with `defer`.

- [ ] **Step 4: Implement the workstation design**

Create `app.css` around these stable tokens and layout rules:

```css
:root {
  color-scheme: light;
  --canvas: #e8e9e5;
  --surface: #f8f8f4;
  --ink: #171815;
  --muted: #666962;
  --line: #c8cbc3;
  --active: #e85d45;
  --success: #087f73;
  --warning: #c88a19;
  --error: #b83b33;
  --radius: 6px;
  font-family: "Aptos", "Segoe UI", sans-serif;
}

.shell { min-height: 100vh; display: grid; grid-template-columns: 248px minmax(420px, 1fr) minmax(360px, 0.9fr); }
.history-rail, .workspace, .evidence { min-width: 0; border-right: 1px solid var(--line); }
.toolbar { min-height: 52px; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
.icon-button, button { min-height: 36px; border-radius: var(--radius); }
.event-log { height: clamp(260px, 44vh, 560px); overflow: auto; font-family: "Cascadia Mono", monospace; }
.preview-frame { width: 100%; height: min(760px, calc(100vh - 150px)); border: 0; background: white; }
@media (max-width: 980px) { .shell { grid-template-columns: 210px 1fr; } .evidence { grid-column: 2; } }
@media (max-width: 720px) { .shell { display: block; } .history-rail { max-height: 190px; } .workspace, .evidence { width: 100%; } .preview-frame { height: 68vh; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
```

Use 1px borders, no nested cards, no gradients, no oversized headings, and no viewport-scaled font sizes. Add explicit hover, focus-visible, disabled, running, success, failed, empty, loading, and mobile tab states.

- [ ] **Step 5: Implement browser behavior**

Create `app.js` with a single state object and these functions:

```js
const state = { status: null, jobs: [], selectedJob: null, events: [], eventSource: null, activeEvidenceTab: 'preview' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

async function boot() { await Promise.all([loadStatus(), loadJobs()]); render(); }
async function saveSession() {
  state.status = await api('/api/session/config', {
    method: 'POST',
    body: JSON.stringify({
      apiKey: document.querySelector('#api-key').value,
      baseUrl: document.querySelector('#base-url').value,
      model: document.querySelector('#model').value,
    }),
  });
  document.querySelector('#api-key').value = '';
  renderStatus();
}
async function launchJob() {
  await saveSession();
  const job = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      title: document.querySelector('#title').value,
      brief: document.querySelector('#brief').value,
      mode: document.querySelector('input[name="mode"]:checked').value,
      baseUrl: document.querySelector('#base-url').value,
      model: document.querySelector('#model').value,
    }),
  });
  state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
  await selectJob(job.id);
}
function connectEvents(id) {
  state.eventSource?.close();
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  source.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    state.selectedJob = { ...state.selectedJob, ...payload.job };
    if (payload.event) state.events.push(payload.event);
    render();
    if (['success', 'failed', 'planned'].includes(payload.job.status)) source.close();
  };
}
async function selectJob(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  state.selectedJob = job;
  state.events = [...(job.events || [])];
  render();
  if (!['success', 'failed', 'planned'].includes(job.status)) connectEvents(id);
}
async function launchPreview() {
  const preview = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}/preview`, { method: 'POST' });
  document.querySelector('#preview-frame').src = preview.url;
}
async function loadReport() {
  const report = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}/report`);
  document.querySelector('#report-content').textContent = report;
}
function render() { renderStatus(); renderHistory(); renderJob(); renderEvidence(); }
```

Implement `loadStatus`, `loadJobs`, `renderStatus`, `renderHistory`, `renderJob`, `renderEvidence`, `showError`, and event-listener registration around the functions above. Use `textContent`, `setAttribute`, and created DOM nodes for external data. Never assign report, event, model, endpoint, or title values through `innerHTML`; clear containers with `replaceChildren()`.

- [ ] **Step 6: Verify GREEN**

Run: `node --test test/console.test.js`

Expected: all console tests pass.

Run: `node --check src/console/public/app.js`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/console/public test/console.test.js
git commit -m "feat: add the Vibe-one browser workspace"
```

### Task 7: Browser Smoke Test, Scripts, Documentation, And Final Verification

**Files:**
- Create: `test/console-e2e.test.js`
- Create: `scripts/run-console-e2e.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `history.md`

- [ ] **Step 1: Write the opt-in Playwright smoke test**

Create `test/console-e2e.test.js` gated by `VIBE_ONE_CONSOLE_E2E=1`. Inject a stub pipeline into `createConsoleServer`; the stub emits `plan:start`, `plan:done`, `build:start`, `review`, and `report:written`, creates a run report and screenshot, and returns success. Test at desktop `1440x900` and mobile `390x844`:

```js
test('browser console submits a brief and renders live evidence', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(address.url);
  await page.getByLabel('API key').fill('stub-secret');
  await page.getByLabel('App brief').fill('Build a compact expense tracker.');
  await page.getByRole('button', { name: 'Launch run' }).click();
  await page.getByText('success', { exact: false }).first().waitFor();
  assert.match(await page.locator('#event-log').innerText(), /planning/i);
  assert.match(await page.locator('#evidence-pane').innerText(), /Delivery Report/i);
  assert.equal((await page.locator('body').innerText()).includes('stub-secret'), false);
  await page.screenshot({ path: desktopShot, fullPage: true });
});
```

Use Node assertions and Playwright locator assertions available from the installed package. Add a second page at mobile viewport and assert `document.documentElement.scrollWidth <= window.innerWidth` and that the brief, history, and evidence tab controls remain visible.

- [ ] **Step 2: Verify RED before adding scripts or UI fixes**

Run: `$env:VIBE_ONE_CONSOLE_E2E='1'; node --test test/console-e2e.test.js`

Expected: FAIL until the injected server/stub helpers and all expected UI states are wired correctly.

- [ ] **Step 3: Add package scripts**

Create `scripts/run-console-e2e.js` so the npm command is cross-platform:

```js
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', 'test/console-e2e.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, VIBE_ONE_CONSOLE_E2E: '1' },
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
```

Update `package.json`:

```json
"scripts": {
  "start": "node src/cli/index.js",
  "console": "node src/console/index.js",
  "demo:expense": "node src/cli/index.js run examples/expense-mobile",
  "demo:notes": "node src/cli/index.js run examples/notes-mobile",
  "test": "node --test \"test/*.test.js\"",
  "test:console:e2e": "node scripts/run-console-e2e.js"
}
```

- [ ] **Step 4: Complete browser fixes until GREEN**

Run: `$env:VIBE_ONE_CONSOLE_E2E='1'; node --test test/console-e2e.test.js`

Expected: desktop and mobile smoke tests pass, screenshots are nonblank, and no secret appears in page text.

- [ ] **Step 5: Update product documentation**

Add `npm run console` to README Quick Start, describe session-only credentials, and replace the CLI-only status statement with separate `Engine` and `Console` status lines. Extend `docs/architecture.md` with the browser -> HTTP/SSE -> job manager -> pipeline data flow and preview ownership. Add a timestamped `history.md` entry with tests, GUI scope, and deferred cancellation/concurrency.

- [ ] **Step 6: Run full verification**

Run: `npm test`

Expected: all offline suites pass; model and full pipeline e2e tests remain explicitly skipped unless opted in.

Run: `$env:VIBE_ONE_CONSOLE_E2E='1'; node --test test/console-e2e.test.js`

Expected: all console browser tests pass.

Run: `$env:VIBE_ONE_E2E='1'; npm test`

Expected: existing normal and repaired pipeline e2e tests plus console tests pass.

Run: `node --check src/console/index.js; node --check src/console/server.js; node --check src/console/jobManager.js; node --check src/console/public/app.js`

Expected: every command exits 0.

Run: `rg -n "sk-[A-Za-z0-9]|7x\.hk|http-secret|top-secret|session-secret|stub-secret" . --glob '!node_modules/**' --glob '!test/**' --glob '!docs/superpowers/**'`

Expected: no matches.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Start the local server and visually verify**

Run: `npm run console`

Expected: prints a working loopback URL. Open it, inspect desktop and mobile screenshots, verify no overlaps or clipped text, submit a Plan Only run with the configured session model, and confirm history, live events, and report rendering.

- [ ] **Step 8: Commit and push**

```bash
git add package.json README.md docs/architecture.md history.md test/console-e2e.test.js scripts/run-console-e2e.js
git commit -m "feat: deliver the Vibe-one local console"
git push origin main
```
