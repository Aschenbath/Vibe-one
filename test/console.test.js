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
import { writeReport } from '../src/reporter/deliveryReport.js';

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
  const manager = createJobManager({ runsRoot: path.join(os.tmpdir(), 'frontend-autopilot-console-status'), pipeline: async () => {} });
  manager.setSessionConfig({ apiKey: 'top-secret', baseUrl: 'https://example.test/v1', model: 'demo' });

  const status = manager.getStatus();

  assert.equal(status.hasApiKey, true);
  assert.equal(status.baseUrl, 'https://example.test/v1');
  assert.equal(status.model, 'demo');
  assert.equal(JSON.stringify(status).includes('top-secret'), false);
});

test('studio state reducer keeps workspace transitions pure and replays events once', async () => {
  const { createStudioState, reduceStudio, deriveStudioStage } = await import(
    '../src/console/public/studio-state.js'
  );
  const initial = createStudioState();
  const event = { ts: '2026-07-13T12:00:00.000Z', type: 'build:start', summary: 'building' };
  let studio = reduceStudio(initial, { type: 'JOB_STARTED', runId: 'r1' });
  studio = reduceStudio(studio, { type: 'DEVICE_SELECTED', device: 'mobile' });
  studio = reduceStudio(studio, { type: 'INSPECTOR_OPENED' });
  studio = reduceStudio(studio, { type: 'EVENTS_REPLAYED', events: [event, event] });
  studio = reduceStudio(studio, { type: 'EVENT_RECEIVED', event });
  studio = reduceStudio(studio, {
    type: 'JOB_UPDATED',
    job: { id: 'r1', status: 'running', stage: 'building' },
  });

  assert.deepEqual(
    { mode: studio.mode, device: studio.canvas.device, drawers: studio.drawers },
    { mode: 'flow', device: 'mobile', drawers: { timeline: false, inspector: true } },
  );
  assert.deepEqual(studio.events, [event]);
  assert.equal(deriveStudioStage(studio), 'building');
  assert.deepEqual(initial, {
    mode: 'focus',
    runId: null,
    selectedJob: null,
    events: [],
    canvas: { device: 'desktop' },
    drawers: { timeline: false, inspector: false },
  });
  assert.notEqual(studio, initial);
  assert.notEqual(studio.canvas, initial.canvas);
  assert.notEqual(studio.drawers, initial.drawers);
  assert.notEqual(studio.events, initial.events);

  const runtimeStatus = { hasApiKey: true };
  const focused = reduceStudio({ ...studio, status: runtimeStatus }, { type: 'WORKSPACE_FOCUSED' });
  assert.equal(focused.mode, 'focus');
  assert.equal(focused.status, runtimeStatus);
});

test('a job streams stages and rejects concurrent starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-job-'));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-reference-'));
  let loaded;
  const manager = createJobManager({
    runsRoot: root,
    env: { FRONTEND_AUTOPILOT_API_KEY: 'secret-key' },
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
    assert.doesNotMatch(serialized, /secret-key|iVBOR|frontend-autopilot-console-reference-/);
    assert.equal(loaded.references.length, 1);
    assert.equal(loaded.references[0].name, 'home.png');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('public jobs and fatal events do not expose endpoints or absolute paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-public-secrecy-'));
  const privateEndpoint = 'https://private.invalid/v1';
  const privatePath = 'D:\\private\\frontend-autopilot-secret\\artifact.txt';
  const manager = createJobManager({
    runsRoot: path.join(root, 'runs'),
    env: {},
    pipeline: async () => {
      throw new Error(`upstream ${privateEndpoint} failed at ${privatePath}`);
    },
  });
  manager.setSessionConfig({
    apiKey: 'public-secrecy-key',
    baseUrl: privateEndpoint,
    model: 'stub',
  });

  try {
    const started = await manager.startJob({ brief: '# Private upstream', mode: 'run' });
    await manager.waitForJob(started.id);
    const job = manager.getJob(started.id);
    const serialized = JSON.stringify(job);

    assert.equal(Object.hasOwn(job, 'baseUrl'), false);
    assert.doesNotMatch(serialized, /private\.invalid|frontend-autopilot-secret|public-secrecy-key/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('visual comparison events expose a visual stage and sanitized error code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-visual-stage-'));
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
    env: { FRONTEND_AUTOPILOT_API_KEY: 'visual-stage-secret' },
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-run-store-'));
  const runDir = path.join(root, 'demo-2026-07-10T12-00-00');
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'references'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'visual'), { recursive: true });
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
  await fs.writeFile(path.join(runDir, 'screenshots', 'visual-home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'references', 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(runDir, 'references', 'manifest.json'),
    JSON.stringify([{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );
  await fs.writeFile(
    path.join(runDir, 'visual', 'comparisons.json'),
    JSON.stringify([{
      round: 0,
      results: [{
        page: '首页',
        referenceImage: 'home.png',
        actualImage: 'visual-home.png',
        score: 0.8,
        structure: 0.8,
        color: 0.8,
        threshold: 0.62,
        pass: true,
      }],
    }]),
  );

  const store = createRunStore(root);
  const [summary] = await store.listRuns();
  const detail = await store.getRun(summary.id);

  assert.equal(summary.id, path.basename(runDir));
  assert.equal(summary.status, 'success');
  assert.equal(summary.repairCount, 1);
  assert.equal(summary.previewEligible, true);
  assert.deepEqual(detail.screenshots, ['home.png', 'visual-home.png']);
  assert.deepEqual(detail.references.map((item) => item.name), ['home.png']);
  assert.equal(detail.visualComparisons[0].results[0].score, 0.8);
  assert.equal(Object.hasOwn(detail, 'runDir'), false);
  assert.equal(JSON.stringify(detail).includes(root), false);
  assert.equal((await store.getPreviewTarget(summary.id)).appDir, path.join(runDir, 'app'));
  const reference = await store.readReference(summary.id, 'home.png');
  assert.equal(reference.type, 'image/png');
  assert.deepEqual(reference.data, ONE_PIXEL_PNG);
  await assert.rejects(store.readScreenshot(summary.id, '../DELIVERY_REPORT.md'), /outside/i);
  await assert.rejects(store.readReference(summary.id, '../home.png'), /outside|invalid/i);

  await fs.rm(root, { recursive: true, force: true });
});

test('HTTP API serves jailed reference images and visual comparison history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-artifacts-'));
  const runsRoot = path.join(root, 'runs');
  const runId = 'visual-run-2026-07-10T12-00-00';
  const runDir = path.join(runsRoot, runId);
  await fs.mkdir(path.join(runDir, 'references'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'visual'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'DELIVERY_REPORT.md'), '# Delivery Report\n- Status: **success**\n');
  await fs.writeFile(path.join(runDir, 'references', 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(runDir, 'references', 'manifest.json'),
    JSON.stringify([{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );
  await fs.writeFile(
    path.join(runDir, 'visual', 'comparisons.json'),
    JSON.stringify([{ round: 0, results: [{ page: '首页', score: 0.8, pass: true }] }]),
  );
  const app = createConsoleServer({ runsRoot, env: {} });
  const address = await app.listen(0);

  try {
    const referenceResponse = await fetch(
      `${address.url}api/jobs/${encodeURIComponent(runId)}/references/home.png`,
    );
    assert.equal(referenceResponse.status, 200);
    assert.equal(referenceResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await referenceResponse.arrayBuffer()), ONE_PIXEL_PNG);

    const visualResponse = await fetch(
      `${address.url}api/jobs/${encodeURIComponent(runId)}/visual`,
    );
    assert.equal(visualResponse.status, 200);
    assert.equal((await visualResponse.json())[0].results[0].score, 0.8);

    const jobResponse = await fetch(`${address.url}api/jobs/${encodeURIComponent(runId)}`);
    const jobText = await jobResponse.text();
    assert.doesNotMatch(jobText, /frontend-autopilot-console-artifacts-|AppData|\\Temp\\/i);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run store reads safe product evidence with legacy fallbacks and jailed images', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-quality-store-'));
  const runId = 'quality-run-2026-07-13T10-00-00';
  const legacyId = 'legacy-run-2026-07-13T09-00-00';
  const corruptId = 'corrupt-run-2026-07-13T08-00-00';
  const linkedRunId = 'linked-run-2026-07-13T07-00-00';
  const runDir = path.join(root, runId);
  const privatePath = 'D:/private/frontend-autopilot-secret/artifact.png';
  const privateCredential = 'sk-store-private-1234567890';
  await Promise.all([
    fs.mkdir(path.join(runDir, 'quality'), { recursive: true }),
    fs.mkdir(path.join(runDir, 'polish', 'quality'), { recursive: true }),
    fs.mkdir(path.join(runDir, 'polish', 'screenshots'), { recursive: true }),
    fs.mkdir(path.join(runDir, 'polish', 'visual'), { recursive: true }),
    fs.mkdir(path.join(root, legacyId), { recursive: true }),
    fs.mkdir(path.join(root, corruptId), { recursive: true }),
  ]);
  await fs.writeFile(path.join(runDir, 'design.json'), JSON.stringify({
    available: true,
    summary: '客服质量工作台',
    productDesign: {
      productType: 'B2B SaaS',
      tone: `Bearer ${privateCredential} cwd=/workspace/secrets.json file=//server/share/key.txt`,
      contentStrategy: 'Error: hidden\n    at secret.js:1:1',
    },
    pages: [{ name: '质量概览', route: '/', purpose: '定位风险' }],
    scenarios: [{ name: '筛选风险', route: '/' }],
    acceptance: ['风险可下钻'],
    secret: privatePath,
  }));
  await fs.writeFile(path.join(runDir, 'quality', 'summary.json'), JSON.stringify({
    available: true,
    rounds: [{
      round: 0,
      summary: { pass: false, failureCount: 1, failures: [{ code: 'HIT_TARGET_TOO_SMALL', screenshot: 'quality.png' }] },
      results: [{ page: '质量概览', viewport: 'mobile', pass: false, screenshot: 'quality.png', actualFile: privatePath }],
      evidence: ['quality.png'],
    }],
    terminal: { summary: { pass: true, failureCount: 0, failures: [] }, results: [] },
    secret: privatePath,
  }));
  await fs.writeFile(path.join(runDir, 'polish', 'summary.json'), JSON.stringify({
    available: true,
    status: 'failed',
    changedFiles: ['src/App.jsx'],
    draft: { review: { pass: true, checkCount: 1, failedCount: 0, checks: [] }, evidence: ['draft.png'] },
    candidate: { review: { pass: false, checkCount: 1, failedCount: 1, checks: [] }, evidence: ['candidate.png'] },
    failureCauseCode: 'POLISH_ROLLBACK_FAILED',
    recovery: { draftRetained: true, recoveryRequired: true },
    secret: privatePath,
  }));
  await Promise.all([
    fs.writeFile(path.join(runDir, 'quality', 'quality.png'), ONE_PIXEL_PNG),
    fs.writeFile(path.join(runDir, 'polish', 'quality', 'polish-quality.webp'), ONE_PIXEL_PNG),
    fs.writeFile(path.join(runDir, 'polish', 'screenshots', 'candidate.png'), ONE_PIXEL_PNG),
    fs.writeFile(path.join(runDir, 'polish', 'visual', 'comparison.jpg'), ONE_PIXEL_PNG),
    fs.writeFile(path.join(runDir, 'quality', 'notes.txt'), 'private'),
    fs.writeFile(path.join(root, corruptId, 'design.json'), '{ private broken json'),
  ]);
  const link = path.join(runDir, 'quality', 'linked.png');
  let linkCreated = true;
  try {
    await fs.symlink(path.join(runDir, 'quality', 'quality.png'), link, 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    linkCreated = false;
  }
  const runLink = path.join(root, linkedRunId);
  let directoryLinkCreated = true;
  try {
    await fs.symlink(runDir, runLink, 'junction');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    directoryLinkCreated = false;
  }
  const store = createRunStore(root);

  try {
    const [design, quality, polish, legacy] = await Promise.all([
      store.readDesign(runId),
      store.readQuality(runId),
      store.readPolish(runId),
      Promise.all([store.readDesign(legacyId), store.readQuality(legacyId), store.readPolish(legacyId)]),
    ]);
    assert.equal(design.available, true);
    assert.equal(design.pages.length, 1);
    assert.equal(quality.rounds[0].results[0].screenshotUrl, `/api/jobs/${runId}/artifacts/quality/quality.png`);
    assert.deepEqual(quality.rounds[0].evidence, [{ file: 'quality.png', url: `/api/jobs/${runId}/artifacts/quality/quality.png` }]);
    assert.deepEqual(polish.draft.evidence, [{ file: 'draft.png', url: `/api/jobs/${runId}/screenshots/draft.png` }]);
    assert.deepEqual(polish.candidate.evidence, [{ file: 'candidate.png', url: `/api/jobs/${runId}/artifacts/polish-screenshots/candidate.png` }]);
    assert.deepEqual(legacy.map((item) => item.available), [false, false, false]);
    assert.doesNotMatch(JSON.stringify({ design, quality, polish }), /frontend-autopilot-secret|actualFile|secret|sk-store-private|Bearer\s+sk-store-private|secret\.js|\n\s*at\s|workspace\/secrets|server\/share\/key/i);

    for (const [bucket, name, type] of [
      ['quality', 'quality.png', 'image/png'],
      ['polish-quality', 'polish-quality.webp', 'image/webp'],
      ['polish-screenshots', 'candidate.png', 'image/png'],
      ['polish-visual', 'comparison.jpg', 'image/jpeg'],
    ]) {
      const artifact = await store.readEvidence(runId, bucket, name);
      assert.equal(artifact.type, type);
      assert.deepEqual(artifact.data, ONE_PIXEL_PNG);
    }
    await assert.rejects(store.readEvidence(runId, 'quality', '../design.json'), (error) => error.code === 'EVIDENCE_NAME_INVALID');
    await assert.rejects(store.readEvidence(runId, 'quality', 'notes.txt'), (error) => error.code === 'EVIDENCE_TYPE_INVALID');
    if (linkCreated) {
      await assert.rejects(store.readEvidence(runId, 'quality', 'linked.png'), (error) => error.code === 'EVIDENCE_LINK_REJECTED');
    }
    if (directoryLinkCreated) {
      await assert.rejects(store.readEvidence(linkedRunId, 'quality', 'quality.png'), (error) => error.code === 'EVIDENCE_LINK_REJECTED');
      await assert.rejects(store.readDesign(linkedRunId), (error) => error.code === 'EVIDENCE_LINK_REJECTED');
    }
    await assert.rejects(store.readEvidence(runId, 'logs', 'events.jsonl'), (error) => error.code === 'EVIDENCE_BUCKET_INVALID');
    await assert.rejects(store.readDesign(corruptId), (error) => (
      error.code === 'EVIDENCE_JSON_INVALID'
      && error.message === 'Evidence data is invalid.'
      && !error.message.includes(root)
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP API exposes safe design quality polish and evidence routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-quality-api-'));
  const runId = 'quality-api-run-2026-07-13T11-00-00';
  const legacyId = 'quality-api-legacy-2026-07-13T10-00-00';
  const corruptId = 'quality-api-corrupt-2026-07-13T09-00-00';
  const runDir = path.join(root, runId);
  await Promise.all([
    fs.mkdir(path.join(runDir, 'quality'), { recursive: true }),
    fs.mkdir(path.join(runDir, 'polish', 'quality'), { recursive: true }),
    fs.mkdir(path.join(root, legacyId), { recursive: true }),
    fs.mkdir(path.join(root, corruptId), { recursive: true }),
  ]);
  await fs.writeFile(path.join(runDir, 'design.json'), JSON.stringify({
    available: true,
    summary: '质量工作台',
    productDesign: { productType: 'B2B SaaS' },
    pages: [], scenarios: [], acceptance: [],
    privateEndpoint: 'https://private.invalid/v1',
  }));
  await fs.writeFile(path.join(runDir, 'quality', 'summary.json'), JSON.stringify({
    available: true,
    rounds: [{
      round: 0,
      summary: { pass: true, failureCount: 0, failures: [] },
      results: [{ page: '质量概览', viewport: 'desktop', pass: true, screenshot: 'quality.png' }],
      evidence: ['quality.png'],
    }],
    terminal: null,
  }));
  await fs.writeFile(path.join(runDir, 'polish', 'summary.json'), JSON.stringify({
    available: true,
    status: 'promoted',
    changedFiles: ['src/App.jsx'],
    draft: null,
    candidate: null,
    failureCauseCode: null,
    recovery: { draftRetained: false, recoveryRequired: false },
  }));
  await fs.writeFile(path.join(runDir, 'quality', 'quality.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'polish', 'quality', 'polish.webp'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'quality', 'private.txt'), 'private');
  await fs.writeFile(path.join(root, corruptId, 'design.json'), '{ broken private data');
  const app = createConsoleServer({ runsRoot: root, env: {} });
  const address = await app.listen(0);

  try {
    for (const resource of ['design', 'quality', 'polish']) {
      const response = await fetch(`${address.url}api/jobs/${runId}/${resource}`);
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(JSON.parse(text).available, true);
      assert.doesNotMatch(text, /private\.invalid|privateEndpoint|AppData|frontend-autopilot-secret/i);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    const legacy = await fetch(`${address.url}api/jobs/${legacyId}/quality`);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).available, false);

    for (const [bucket, name, type] of [
      ['quality', 'quality.png', 'image/png'],
      ['polish-quality', 'polish.webp', 'image/webp'],
    ]) {
      const response = await fetch(`${address.url}api/jobs/${runId}/artifacts/${bucket}/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), type);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), ONE_PIXEL_PNG);
    }
    const traversal = await fetch(`${address.url}api/jobs/${runId}/artifacts/quality/%2e%2e%2fdesign.json`);
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).error.code, 'EVIDENCE_NAME_INVALID');
    const unsupported = await fetch(`${address.url}api/jobs/${runId}/artifacts/quality/private.txt`);
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, 'EVIDENCE_TYPE_INVALID');

    const corrupt = await fetch(`${address.url}api/jobs/${corruptId}/design`);
    const corruptText = await corrupt.text();
    assert.equal(corrupt.status, 500);
    assert.deepEqual(JSON.parse(corruptText), {
      error: { code: 'EVIDENCE_JSON_INVALID', message: 'Evidence data is invalid.' },
    });
    assert.doesNotMatch(corruptText, /broken private|quality-api-corrupt|AppData|frontend-autopilot-secret/i);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeReport and HTTP evidence redact labeled secrets and raw raster base64 without hiding ordinary text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-report-sanitize-'));
  const runId = 'sanitize-report-run-2026-07-13T13-55-00';
  const runDir = path.join(root, runId);
  const rawPngBase64 = ONE_PIXEL_PNG.toString('base64');
  const rawJpegBase64 = '/9j/' + 'A'.repeat(64);
  const rawWebpBase64 = 'UklGR' + 'B'.repeat(64);
  const ctx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) { this.events.push({ type, ...data }); },
  };

  await writeReport(ctx, {
    config: {
      model: 'stub', stack: 'react-vite', maxRepairRounds: 1, references: [],
    },
    spec: {
      summary: 'token usage dashboard; apiKey => opaque.custom/value-987654; token = arbitrary.token/value',
      productDesign: { productType: 'Secret Garden catalog', targetUsers: ['analysts'] },
      pages: [{
        name: 'Overview', route: '/', purpose: 'authorization flow',
        mustContain: [
          'token usage',
          'authorization: Custom opaque-auth-value',
          rawPngBase64,
          rawJpegBase64,
        ],
      }],
      scenarios: [],
      acceptance: [
        'Secret Garden stays visible',
        'credential :: another-custom-secret-value',
        'secret := custom-secret-material',
        rawWebpBase64,
      ],
    },
    status: 'success', rounds: 0, finalReview: { pass: true, checks: [] },
    shots: [], scenarioResults: [], qualityHistory: [], uiQuality: null,
  });

  const app = createConsoleServer({ runsRoot: root, env: {} });
  const address = await app.listen(0);
  try {
    const report = await (await fetch(`${address.url}api/jobs/${runId}/report`)).text();
    const design = await (await fetch(`${address.url}api/jobs/${runId}/design`)).text();
    const published = `${report}\n${design}`;
    assert.doesNotMatch(
      published,
      /opaque\.custom|arbitrary\.token|opaque-auth-value|another-custom-secret-value|custom-secret-material|iVBORw0KGgo|\/9j\/|UklGR/i,
    );
    assert.match(published, /token usage/);
    assert.match(published, /Secret Garden/);
    assert.match(published, /authorization flow/);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('RunStore does not expose a partially published new evidence bundle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-report-partial-'));
  const runId = 'partial-report-run-2026-07-13T13-56-00';
  const runDir = path.join(root, runId);
  await fs.mkdir(runDir, { recursive: true });
  const ctx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) { this.events.push({ type, ...data }); },
  };
  const failingFs = {
    ...fs,
    async rename(source, destination) {
      if (String(destination).includes('.evidence-bundles')) {
        const error = new Error('injected first publication failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(source, destination);
    },
  };

  await assert.rejects(writeReport(ctx, {
    config: { model: 'stub', stack: 'react-vite', maxRepairRounds: 1, references: [] },
    spec: { summary: 'partial evidence', pages: [], scenarios: [], acceptance: [] },
    status: 'failed', rounds: 0, finalReview: { pass: false, checks: [] },
    shots: [], scenarioResults: [], qualityHistory: [], uiQuality: null,
  }, { evidenceFs: failingFs }));

  const store = createRunStore(root);
  const [design, polish] = await Promise.all([store.readDesign(runId), store.readPolish(runId)]);
  assert.equal(design.available, false);
  assert.equal(polish.available, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('secure evidence read rejects an lstat-to-open file swap without leaking raced content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-evidence-race-'));
  const runId = 'evidence-race-run-2026-07-13T14-10-00';
  const runDir = path.join(root, runId);
  const target = path.join(runDir, 'design.json');
  const backup = path.join(runDir, 'design.safe.json');
  const outside = path.join(root, 'outside-secret.json');
  const racedSecret = 'race-private-credential-value';
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify({ available: true, summary: 'safe design' }));
  await fs.writeFile(outside, JSON.stringify({ available: true, summary: racedSecret }));
  let raced = false;
  const evidenceFs = {
    ...fs,
    async open(file, flags) {
      if (!raced && path.resolve(file) === path.resolve(target)) {
        raced = true;
        await fs.rename(target, backup);
        await fs.link(outside, target);
        const handle = await fs.open(target, flags);
        await fs.rm(target, { force: true });
        await fs.rename(backup, target);
        return handle;
      }
      return fs.open(file, flags);
    },
  };
  const store = createRunStore(root, { evidenceFs });

  try {
    await assert.rejects(store.readDesign(runId), (error) => (
      error.code === 'EVIDENCE_CHANGED'
      && error.message === 'Evidence changed during secure read.'
      && !error.message.includes(racedSecret)
      && !error.message.includes(root)
    ));
    assert.equal(raced, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secure evidence read accepts a zero path device id when the inode still matches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-zero-device-'));
  const runId = 'zero-device-run-2026-07-14T16-00-00';
  const runDir = path.join(root, runId);
  const target = path.join(runDir, 'design.json');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify({ available: true, summary: 'stable design' }));
  const evidenceFs = {
    ...fs,
    async lstat(file, options) {
      const stat = await fs.lstat(file, options);
      if (path.resolve(file) !== path.resolve(target)) return stat;
      return new Proxy(stat, {
        get(value, property) {
          if (property === 'dev') return 0;
          const member = Reflect.get(value, property, value);
          return typeof member === 'function' ? member.bind(value) : member;
        },
      });
    },
  };

  try {
    const design = await createRunStore(root, { evidenceFs }).readDesign(runId);
    assert.equal(design.available, true);
    assert.equal(design.summary, 'stable design');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('committed evidence reads an immutable bundle when the root mirror changes after marker read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-bundle-race-'));
  const runId = 'bundle-race-run-2026-07-13T14-30-00';
  const runDir = path.join(root, runId);
  const ctx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) { this.events.push({ type, ...data }); },
  };
  await writeReport(ctx, {
    config: { model: 'stub', stack: 'react-vite', maxRepairRounds: 1, references: [] },
    spec: { summary: 'committed design', pages: [], scenarios: [], acceptance: [] },
    status: 'success', rounds: 0, finalReview: { pass: true, checks: [] },
    shots: [], scenarioResults: [], qualityHistory: [], uiQuality: null,
  });

  const marker = path.join(runDir, '.evidence-bundle.json');
  const rootDesign = path.join(runDir, 'design.json');
  let markerRead = false;
  const evidenceFs = {
    ...fs,
    async open(file, flags) {
      const handle = await fs.open(file, flags);
      if (path.resolve(file) !== path.resolve(marker)) return handle;
      return {
        stat: (...args) => handle.stat(...args),
        close: (...args) => handle.close(...args),
        async readFile(...args) {
          const content = await handle.readFile(...args);
          markerRead = true;
          await fs.writeFile(rootDesign, JSON.stringify({
            available: true,
            summary: 'NEW_UNCOMMITTED_PRIVATE',
          }));
          return content;
        },
      };
    },
  };

  try {
    const design = await createRunStore(root, { evidenceFs }).readDesign(runId);
    assert.equal(markerRead, true);
    assert.equal(design.summary, 'committed design');
    assert.doesNotMatch(JSON.stringify(design), /NEW_UNCOMMITTED_PRIVATE/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP evidence URLs keep every referenced raster in the committed bundle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-raster-bundle-'));
  const runId = 'raster-bundle-run-2026-07-13T14-45-00';
  const runDir = path.join(root, runId);
  const files = [
    ['quality', 'draft-quality.png'],
    ['polish', 'quality', 'candidate-quality.webp'],
    ['polish', 'screenshots', 'candidate.png'],
    ['polish', 'screenshots', 'visual-candidate.jpg'],
    ['screenshots', 'draft.png'],
  ];
  await Promise.all(files.map((parts) => fs.mkdir(path.dirname(path.join(runDir, ...parts)), { recursive: true })));
  await Promise.all(files.map((parts) => fs.writeFile(path.join(runDir, ...parts), ONE_PIXEL_PNG)));
  await fs.writeFile(path.join(runDir, 'quality', 'unreferenced.png'), ONE_PIXEL_PNG);
  const ctx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) { this.events.push({ type, ...data }); },
  };

  await writeReport(ctx, {
    config: { model: 'stub', stack: 'react-vite', maxRepairRounds: 1, references: [] },
    spec: { summary: 'immutable raster evidence', pages: [], scenarios: [], acceptance: [] },
    status: 'success', rounds: 0, finalReview: { pass: true, checks: [] },
    shots: [{ page: 'Late', file: 'late.png', bytes: ONE_PIXEL_PNG.length }],
    scenarioResults: [],
    qualityHistory: [{
      round: 0,
      summary: { pass: true, failures: [] },
      results: [{ page: 'Draft', viewport: 'desktop', pass: true, screenshot: 'draft-quality.png' }],
    }],
    uiQuality: {
      summary: { pass: true, failures: [] },
      results: [{ page: 'Candidate', viewport: 'desktop', pass: true, screenshot: 'candidate-quality.webp' }],
    },
    polish: {
      status: 'promoted', changedFiles: ['src/App.jsx'],
      draftEvidence: {
        review: { pass: true, checks: [] },
        screenshots: ['draft.png'],
      },
      candidateEvidence: {
        review: { pass: true, checks: [] },
        uiQuality: { summary: { pass: true, failures: [] } },
        screenshots: ['candidate.png'],
        visualResults: [{ actualImage: 'visual-candidate.jpg' }],
      },
      recovery: { draftRetained: true, recoveryRequired: false },
    },
  });

  const replacement = Buffer.from('replacement-raster');
  await Promise.all(files.map((parts) => fs.writeFile(path.join(runDir, ...parts), replacement)));
  await fs.writeFile(path.join(runDir, 'screenshots', 'late.png'), replacement);
  const app = createConsoleServer({ runsRoot: root, env: {} });
  const address = await app.listen(0);
  try {
    const quality = await (await fetch(`${address.url}api/jobs/${runId}/quality`)).json();
    const polish = await (await fetch(`${address.url}api/jobs/${runId}/polish`)).json();
    const urls = [
      quality.rounds[0].results[0].screenshotUrl,
      quality.terminal.results[0].screenshotUrl,
      polish.candidate.evidence[0].url,
      polish.candidate.visualEvidence[0].url,
    ];
    const draftUrl = polish.draft.evidence[0].url;
    assert.deepEqual(urls.map((url) => url.split('/artifacts/')[1].split('/')[0]), [
      'quality', 'polish-quality', 'polish-screenshots', 'polish-visual',
    ]);
    for (const url of urls) {
      const response = await fetch(new URL(url, address.url));
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), ONE_PIXEL_PNG);
    }
    const draftResponse = await fetch(new URL(draftUrl, address.url));
    assert.equal(draftResponse.status, 200);
    assert.deepEqual(Buffer.from(await draftResponse.arrayBuffer()), ONE_PIXEL_PNG);
    const late = await fetch(`${address.url}api/jobs/${runId}/screenshots/late.png`);
    assert.equal(late.status, 404);
    const unreferenced = await fetch(`${address.url}api/jobs/${runId}/artifacts/quality/unreferenced.png`);
    assert.equal(unreferenced.status, 404);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed republish keeps the previous committed evidence bundle readable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-bundle-republish-'));
  const runId = 'bundle-republish-run-2026-07-13T14-31-00';
  const runDir = path.join(root, runId);
  const ctx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) { this.events.push({ type, ...data }); },
  };
  const reportInput = (summary) => ({
    config: { model: 'stub', stack: 'react-vite', maxRepairRounds: 1, references: [] },
    spec: { summary, pages: [], scenarios: [], acceptance: [] },
    status: 'success', rounds: 0, finalReview: { pass: true, checks: [] },
    shots: [], scenarioResults: [], qualityHistory: [], uiQuality: null,
  });
  await writeReport(ctx, reportInput('first committed design'));
  const failingFs = {
    ...fs,
    async rename(source, destination) {
      if (String(destination).includes('.evidence-bundles')) {
        const error = new Error('injected bundle publication failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(source, destination);
    },
  };

  try {
    await assert.rejects(
      writeReport(ctx, reportInput('second uncommitted design'), { evidenceFs: failingFs }),
      /injected bundle publication failure/,
    );
    const design = await createRunStore(root).readDesign(runId);
    assert.equal(design.available, true);
    assert.equal(design.summary, 'first committed design');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secure evidence read rejects a hard-link swap that remains through the second fstat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-evidence-hardlink-'));
  const runId = 'evidence-hardlink-run-2026-07-13T14-32-00';
  const runDir = path.join(root, runId);
  const target = path.join(runDir, 'design.json');
  const backup = path.join(runDir, 'design.safe.json');
  const outside = path.join(root, 'outside-hardlink-secret.json');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify({ available: true, summary: 'safe design' }));
  await fs.writeFile(outside, JSON.stringify({ available: true, summary: 'HARDLINK_PRIVATE' }));
  let swapped = false;
  const evidenceFs = {
    ...fs,
    async open(file, flags) {
      if (!swapped && path.resolve(file) === path.resolve(target)) {
        swapped = true;
        await fs.rename(target, backup);
        await fs.link(outside, target);
      }
      return fs.open(file, flags);
    },
  };

  try {
    await assert.rejects(
      createRunStore(root, { evidenceFs }).readDesign(runId),
      (error) => error.code === 'EVIDENCE_LINK_REJECTED'
        && error.message === 'Linked evidence is not available.'
        && !error.message.includes(root)
        && !error.message.includes('HARDLINK_PRIVATE'),
    );
    assert.equal(swapped, true);
  } finally {
    await fs.rm(target, { force: true }).catch(() => {});
    await fs.rename(backup, target).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-http-'));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-http-reference-'));
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
    assert.doesNotMatch(body, /http-reference-secret|iVBOR|frontend-autopilot-console-http-reference-/);
    await waitForTerminalJob(address.url, job.id);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP API returns structured validation errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-http-errors-'));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-http-headers-'));
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

test('console serves the Studio state module as same-origin JavaScript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-studio-state-module-'));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);

  try {
    const response = await fetch(`${address.url}studio-state.js`);
    const source = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript; charset=utf-8$/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(source, /export function createStudioState/);
    assert.match(source, /export function reduceStudio/);
    assert.match(source, /export function deriveStudioStage/);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bEventSource\b|document\.|window\./);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('console page exposes the complete operational workflow', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-ui-'));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);

  try {
  const response = await fetch(address.url);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /把想法整理成一份产品任务书/);
  assert.match(html, /使用 SignalDesk 起点/);
  assert.match(html, /id="product-goal"/);
  assert.match(html, /id="target-users"/);
  assert.match(html, /id="visual-direction"/);
  assert.match(html, /参考截图/);
  assert.match(html, /开始生成/);
  assert.match(html, /运行设置/);
  assert.match(html, /生产时间线/);
  assert.match(html, /作品画布/);
  assert.match(html, /质量与证据/);
  assert.match(html, /id="brief"/);
  assert.match(html, /id="launch-run"/);
  assert.match(html, /id="run-history"/);
  assert.match(html, /id="event-log"/);
  assert.match(html, /id="preview-frame"/);
  assert.match(html, /id="history-drawer"/);
  assert.match(html, /id="reference-input"/);
  assert.match(html, /id="reference-list"/);
  assert.match(html, /id="settings-drawer"/);
  assert.match(html, /id="flow-workspace"/);
  assert.match(html, /id="visual-comparisons"/);
  assert.match(html, /<aside[^>]*id="history-drawer"[^>]*class="history-drawer"[^>]*aria-label="生成历史"/);
  assert.match(html, /<button[^>]*id="history-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="history-panel"[^>]*>展开历史<\/button>/);
  assert.match(html, /<nav[^>]*id="run-history"[^>]*aria-label="历史任务"/);
  assert.match(html, /<header class="app-header">/);
  assert.match(html, /<section[^>]*id="focus-workspace"[^>]*class="focus-workspace"/);
  assert.match(html, /<section[^>]*id="flow-workspace"[^>]*class="flow-workspace"[^>]*hidden/);
  assert.match(html, /<form[^>]*id="run-form"[^>]*novalidate/);
  assert.match(html, /<button[^>]*id="reference-trigger"[^>]*aria-controls="reference-input"[^>]*>\s*<strong>添加参考截图<\/strong>\s*<span>PNG、JPEG 或 WebP，最多 4 张<\/span>\s*<\/button>/);
  assert.match(html, /<ol[^>]*id="reference-list"[^>]*aria-label="参考截图"[^>]*><\/ol>/);
  assert.match(html, /<ol[^>]*id="stage-track"[^>]*aria-label="生成阶段"/);
  assert.match(html, /<ol[^>]*id="event-log"[^>]*aria-live="polite"/);
  assert.match(html, /<div class="flow-grid studio-grid">/);
  assert.match(html, /<nav[^>]*class="studio-timeline"[^>]*aria-label="生产时间线"/);
  assert.match(html, /<main[^>]*id="product-canvas"[^>]*aria-label="作品画布"/);
  assert.match(html, /<aside[^>]*id="inspector-panel"[^>]*aria-label="质量 Inspector"/);
  assert.match(html, /<fieldset>\s*<legend>执行方式<\/legend>/);
  assert.match(html, /<input[^>]*id="api-key"[^>]*type="password"[^>]*autocomplete="off"/);
  assert.match(html, /<div[^>]*id="toast"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /Build from a brief|Launch run|Delivery console/);

  const appSource = await fs.readFile(new URL('../src/console/public/app.js', import.meta.url), 'utf8');
  for (const [, id] of appSource.matchAll(/getElementById\('([^']+)'\)/g)) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `app.js selector #${id} must exist in index.html`);
  }
  for (const [, id] of appSource.matchAll(/querySelector\('#([^']+)'\)/g)) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `app.js selector #${id} must exist in index.html`);
  }
  assert.doesNotMatch(
    appSource,
    /Session key cleared|Starting\.\.\.|Restart preview|Launch preview|No Delivery Report|Loading Delivery Report|Model not loaded|Events will appear|Reconnecting|Select a successful|Verified build|This run does not|Preview becomes available|No screenshots|Generated screenshot|No repair attempts|Repair event|Local server online|Local server unavailable/,
  );

  const copyResponse = await fetch(`${address.url}copy.js`);
  assert.equal(copyResponse.status, 200);
  assert.match(await copyResponse.text(), /理解需求/);

  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('console serves the Product Studio renderer module', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-console-renderers-')));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);
  try {
    const response = await fetch(`${address.url}studio-renderers.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /renderStudioTimeline/);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
