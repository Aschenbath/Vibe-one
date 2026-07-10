import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobManager } from '../src/console/jobManager.js';

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
