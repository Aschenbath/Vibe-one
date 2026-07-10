import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobManager } from '../src/console/jobManager.js';
import { createRunStore } from '../src/console/runStore.js';
import { createPreviewManager } from '../src/console/previewManager.js';
import { createConsoleServer } from '../src/console/server.js';

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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pipeline = async ({ config }) => {
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

  await fs.rm(root, { recursive: true, force: true });
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
  assert.equal(jobResponse.status, 202);
  assert.equal((await jobResponse.text()).includes('http-secret'), false);

  await app.close();
  await fs.rm(root, { recursive: true, force: true });
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
    error: { code: 'BRIEF_REQUIRED', message: 'Describe the app before starting.' },
  });

  await app.close();
  await fs.rm(root, { recursive: true, force: true });
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
