import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { createJobManager } from '../src/console/jobManager.js';
import { createRunStore } from '../src/console/runStore.js';
import { createPreviewManager } from '../src/console/previewManager.js';
import { createConsoleServer } from '../src/console/server.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function createLargeSyntheticPng(bytes = 1_100_000) {
  const buffer = Buffer.alloc(bytes);
  ONE_PIXEL_PNG.copy(buffer, 0, 0, 24);
  return buffer;
}

async function waitForTerminalJob(baseUrl, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}api/jobs/${encodeURIComponent(id)}`);
    const job = await response.json();
    if (job.terminal) return job;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`job did not reach a terminal state: ${id}`);
}

test('session status exposes key presence but never the key', () => {
  const manager = createJobManager({ runsRoot: path.join(os.tmpdir(), 'vibe-console-status'), pipeline: async () => {} });
  manager.setSessionConfig({ apiKey: 'top-secret', baseUrl: 'https://example.test/v1', model: 'demo' });

  const status = manager.getStatus();

  assert.equal(status.hasApiKey, true);
  assert.equal(status.baseUrl, 'https://example.test/v1');
  assert.equal(status.model, 'demo');
  assert.equal(JSON.stringify(status).includes('top-secret'), false);
});

test('a job streams stages and rejects concurrent starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-job-'));
  let release;
  let pipelineTargetDir;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pipeline = async ({ config, targetDir }) => {
    pipelineTargetDir = targetDir;
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:start', summary: 'planning' });
    await gate;
    config.onEvent({ ts: new Date().toISOString(), type: 'report:written', summary: 'report' });
    return { runId: 'demo-run', runDir: path.join(root, 'runs', 'demo-run'), status: 'success' };
  };
  const manager = createJobManager({ runsRoot: path.join(root, 'runs'), pipeline, env: {} });
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
  assert.equal(finished.stage, 'success');
  assert.equal(finished.events[0].type, 'plan:start');
  assert.equal(JSON.stringify(finished).includes('secret'), false);
  assert.match(path.basename(pipelineTargetDir), /^demo-[a-f0-9]{8}$/);

  await fs.rm(root, { recursive: true, force: true });
});

test('a screenshot-only job persists references without exposing base64, paths, or secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-reference-'));
  let loaded;
  const manager = createJobManager({
    runsRoot: root,
    env: { VIBE_ONE_API_KEY: 'secret-key' },
    load: async (targetDir, overrides) => {
      loaded = await loadConfig(targetDir, overrides);
      return { ...loaded, model: 'stub', baseUrl: 'local' };
    },
    pipeline: async ({ config }) => ({
      runId: 'run-1',
      runDir: path.join(root, 'run-1'),
      status: config.references.length ? 'planned' : 'failed',
    }),
  });
  const payload = {
    name: 'home.png',
    type: 'image/png',
    width: 1,
    height: 1,
    base64: ONE_PIXEL_PNG.toString('base64'),
  };

  try {
    const job = await manager.startJob({
      title: 'Screenshot clone',
      brief: '',
      references: [payload],
      mode: 'plan',
    });
    await manager.waitForJob(job.id);
    const publicJob = manager.getJob(job.id);
    const serialized = JSON.stringify(publicJob);

    assert.equal(publicJob.referenceCount, 1);
    assert.deepEqual(publicJob.references, ['home.png']);
    assert.equal(publicJob.inputMode, 'images');
    assert.doesNotMatch(serialized, /secret-key|iVBOR|vibe-console-reference-/);
    assert.equal(loaded.references.length, 1);
    assert.equal(loaded.references[0].name, 'home.png');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('visual comparison events expose a visual stage and sanitized error code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-visual-stage-'));
  let release;
  let markVisual;
  const visualReady = new Promise((resolve) => {
    markVisual = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const manager = createJobManager({
    runsRoot: root,
    env: { VIBE_ONE_API_KEY: 'visual-stage-secret' },
    pipeline: async ({ config }) => {
      config.onEvent({
        type: 'visual:compare',
        code: 'VISUAL_LOW',
        summary: 'visual-stage-secret score below threshold',
      });
      markVisual();
      await gate;
      return { runId: 'run-visual', runDir: path.join(root, 'run-visual'), status: 'failed' };
    },
  });

  try {
    const job = await manager.startJob({ brief: '# Visual app', mode: 'run' });
    await visualReady;
    const live = manager.getJob(job.id);

    assert.equal(live.stage, 'visual');
    assert.equal(live.events[0].code, 'VISUAL_LOW');
    assert.doesNotMatch(JSON.stringify(live), /visual-stage-secret/);
    release();
    await manager.waitForJob(job.id);
  } finally {
    release?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run store reconstructs evidence and rejects traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-store-'));
  const runDir = path.join(root, 'demo-2026-07-10T12-00-00');
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'app'), { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'logs', 'events.jsonl'),
    '{"ts":"2026-07-10T12:00:00Z","type":"fix:applied","summary":"repair round 1"}\n',
  );
  await fs.writeFile(
    path.join(runDir, 'DELIVERY_REPORT.md'),
    '# Delivery Report\n- Status: **success**\n- Model: demo @ local\n',
  );
  await fs.writeFile(path.join(runDir, 'screenshots', 'home.png'), 'png');

  const store = createRunStore(root);
  const [summary] = await store.listRuns();
  const detail = await store.getRun(summary.id);

  assert.equal(summary.id, path.basename(runDir));
  assert.equal(summary.status, 'success');
  assert.equal(summary.repairCount, 1);
  assert.equal(summary.previewEligible, true);
  assert.deepEqual(detail.screenshots, ['home.png']);
  assert.equal(Object.hasOwn(detail, 'runDir'), false);
  assert.equal((await store.getPreviewTarget(summary.id)).appDir, path.join(runDir, 'app'));
  await assert.rejects(store.readScreenshot(summary.id, '../DELIVERY_REPORT.md'), /outside/i);

  await fs.rm(root, { recursive: true, force: true });
});

test('preview manager reuses one preview and stops it on replacement', async () => {
  const stopped = [];
  let calls = 0;
  const manager = createPreviewManager({
    start: async () => {
      calls += 1;
      const id = calls;
      return { url: `http://127.0.0.1:${4100 + id}/`, stop: () => stopped.push(id) };
    },
  });

  const first = await manager.open({ id: 'a', status: 'success', appDir: path.join(os.tmpdir(), 'a', 'app') });

  assert.deepEqual(await manager.open({ id: 'a', status: 'success', appDir: path.join(os.tmpdir(), 'a', 'app') }), first);
  await manager.open({ id: 'b', status: 'success', appDir: path.join(os.tmpdir(), 'b', 'app') });
  assert.deepEqual(stopped, [1]);
  manager.close();
  assert.deepEqual(stopped, [1, 2]);
});

test('HTTP API configures a session and starts a job without exposing the key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-http-'));
  const pipeline = async ({ config }) => {
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:start', summary: 'planning' });
    return { runId: 'run-1', runDir: path.join(root, 'runs', 'run-1'), status: 'planned' };
  };
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), pipeline, env: {} });
  const address = await app.listen(0);

  const configResponse = await fetch(`${address.url}api/session/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'http-secret' }),
  });
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.text()).includes('http-secret'), false);

  const jobResponse = await fetch(`${address.url}api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Demo', brief: '# Demo', mode: 'plan' }),
  });
  const jobBody = await jobResponse.text();
  const job = JSON.parse(jobBody);
  assert.equal(jobResponse.status, 202);
  assert.equal(jobBody.includes('http-secret'), false);
  await waitForTerminalJob(address.url, job.id);

  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('HTTP job creation accepts screenshot-only payloads above the default JSON limit safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-http-reference-'));
  const pipeline = async ({ config }) => ({
    runId: 'run-reference',
    runDir: path.join(root, 'runs', 'run-reference'),
    status: config.references.length ? 'planned' : 'failed',
  });
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), pipeline, env: {} });
  const address = await app.listen(0);
  const image = createLargeSyntheticPng();

  try {
    await fetch(`${address.url}api/session/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'http-reference-secret' }),
    });
    const response = await fetch(`${address.url}api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Screenshot only',
        brief: '',
        mode: 'plan',
        references: [{
          name: 'home.png',
          type: 'image/png',
          width: 1,
          height: 1,
          base64: image.toString('base64'),
        }],
      }),
    });
    const body = await response.text();
    const job = JSON.parse(body);

    assert.equal(response.status, 202);
    assert.deepEqual(job.references, ['home.png']);
    assert.equal(job.referenceCount, 1);
    assert.equal(job.inputMode, 'images');
    assert.doesNotMatch(body, /http-reference-secret|iVBOR|vibe-console-http-reference-/);
    await waitForTerminalJob(address.url, job.id);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP API returns structured validation errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-http-errors-'));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);

  const response = await fetch(`${address.url}api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brief: '', mode: 'run' }),
  });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: { code: 'INPUT_REQUIRED', message: '请填写需求描述或上传至少一张参考图。' },
  });

  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('HTTP responses include local-console browser security headers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-http-headers-'));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);

  try {
    const response = await fetch(`${address.url}api/status`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('console page exposes the complete operational workflow', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-ui-'));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);

  const response = await fetch(address.url);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /id="brief"/);
  assert.match(html, /id="launch-run"/);
  assert.match(html, /id="run-history"/);
  assert.match(html, /id="event-log"/);
  assert.match(html, /id="evidence-pane"/);
  assert.match(html, /id="preview-frame"/);

  await app.close();
  await fs.rm(root, { recursive: true, force: true });
});
