// Offline unit tests: no network, no model. Pins the safety-critical helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILDER_SYSTEM, safeJoin } from '../src/core/builder.js';
import { parseFileBlocks } from '../src/core/builder.js';
import { createProvider, extractJson, resolveRequestTimeout } from '../src/providers/openaiCompatible.js';
import { review } from '../src/core/reviewer.js';
import { createFixerUserContent, describeFailure, gatherSource } from '../src/core/fixer.js';
import { writeReport } from '../src/reporter/deliveryReport.js';
import { exitCodeForStatus } from '../src/cli/status.js';
import { createRunContext } from '../src/core/runContext.js';
import { loadConfig } from '../src/core/config.js';
import { PLANNER_SYSTEM, createPlannerUserContent, plan } from '../src/core/planner.js';
import { runPipeline } from '../src/core/pipeline.js';
import {
  REFERENCE_LIMITS,
  normalizeReferencePayloads,
  writeReferencePayloads,
  discoverReferenceImages,
} from '../src/core/referenceImages.js';

const APP = path.resolve('/tmp/run/app');
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('package test command is compatible with the Node 20 CI runner', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts.test,
    'node --test test/console.test.js test/console-e2e.test.js test/core.test.js test/e2e.test.js test/visual.test.js',
  );
  assert.doesNotMatch(pkg.scripts.test, /[*?]/);
});

test('builder prompt keeps model output within the gateway-friendly MVP budget', () => {
  assert.match(BUILDER_SYSTEM, /at most 8 files/i);
  assert.match(BUILDER_SYSTEM, /12,000 characters/i);
  assert.match(BUILDER_SYSTEM, /src\/App\.jsx/);
});

test('planned and successful runs exit cleanly', () => {
  assert.equal(exitCodeForStatus('planned'), 0);
  assert.equal(exitCodeForStatus('success'), 0);
  assert.equal(exitCodeForStatus('failed'), 2);
});

test('safeJoin allows normal relative paths', () => {
  assert.equal(safeJoin(APP, 'src/main.jsx'), path.resolve(APP, 'src/main.jsx'));
});

test('safeJoin rejects traversal and absolute paths', () => {
  assert.throws(() => safeJoin(APP, '../outside.txt'));
  assert.throws(() => safeJoin(APP, '..\\outside.txt'));
  assert.throws(() => safeJoin(APP, path.resolve('/etc/passwd')));
  assert.throws(() => safeJoin(APP, 'C:\\Windows\\evil.js'));
});

test('portable absolute-path detection rejects Windows and POSIX forms on every host OS', async () => {
  const builder = await import('../src/core/builder.js');
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('C:\\Windows\\evil.js'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('\\\\server\\share\\evil.js'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('/etc/passwd'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('src/App.jsx'), false);
});

test('safeJoin rejects pipeline-owned files', () => {
  assert.throws(() => safeJoin(APP, 'package.json'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'vite.config.js'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, '.npmrc'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'node_modules/react/index.js'), /pipeline-owned/);
  // normal app files still allowed
  assert.ok(safeJoin(APP, 'src/App.jsx'));
});

test('extractJson tolerates markdown fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('not json'));
});

test('provider preserves OpenAI-compatible multimodal user content', async (t) => {
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const provider = createProvider({
    model: 'vision-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });
  const content = [
    { type: 'text', text: 'Clone this UI' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ];

  await provider.chatJson({ system: 'system', user: content });

  assert.deepEqual(requestBody.messages[1].content, content);
});

test('provider rejects unsupported multimodal parts before sending a request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const provider = createProvider({
    model: 'vision-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });

  await assert.rejects(
    provider.chat({ user: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,AAAA' } }] }),
    /unsupported part/,
  );
  assert.equal(calls, 0);
});

test('provider returns a coded error when the upstream rejects visual content', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    'image content is not supported by this model',
    { status: 415 },
  ));
  const provider = createProvider({
    model: 'text-only-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });

  await assert.rejects(
    provider.chat({
      user: [
        { type: 'text', text: 'Clone this UI' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }),
    (error) => error.code === 'VISION_UNSUPPORTED',
  );
});

test('planner content includes reference images and visual schema instructions', () => {
  const content = createPlannerUserContent({
    brief: '做一个记账产品',
    references: [{
      name: 'home.png',
      type: 'image/png',
      width: 390,
      height: 844,
      buffer: ONE_PIXEL_PNG,
    }],
  });

  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /home\.png.*390x844/s);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(PLANNER_SYSTEM, /visualDesign/);
  assert.match(PLANNER_SYSTEM, /referenceImage/);
});

test('planner rejects incomplete or unsafe visual mappings for reference jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-planner-visual-contract-'));
  const reference = {
    name: 'home.png',
    type: 'image/png',
    width: 1,
    height: 1,
    buffer: ONE_PIXEL_PNG,
  };
  const ctx = {
    runDir: root,
    logEvent: async () => {},
    addUsage: () => {},
  };
  const config = {
    brief: '',
    references: [reference],
    stack: 'react-vite',
    viewport: { width: 1, height: 1 },
    maxRepairRounds: 0,
  };
  const invalidSpecs = [
    { pages: [{ name: 'Home', route: '/', referenceImage: 'home.png' }] },
    {
      visualDesign: visualDesignFixture(),
      pages: [{ name: 'Home', route: '/', referenceImage: 'missing.png' }],
    },
    {
      visualDesign: visualDesignFixture(),
      pages: [{ name: 'Home', route: '/', referenceImage: null }],
    },
  ];

  try {
    for (const spec of invalidSpecs) {
      await assert.rejects(
        plan(ctx, { chatJson: async () => ({ json: spec }) }, config),
        (error) => error.code === 'VISUAL_PLAN_INVALID',
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pipeline fails before build when a reference is not mapped by the planner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-pipeline-visual-contract-'));
  const targetDir = path.join(root, 'target');
  let buildCalls = 0;
  const config = {
    stack: 'react-vite',
    viewport: { width: 1, height: 1 },
    maxRepairRounds: 0,
    model: 'stub',
    baseUrl: 'http://stub.local/v1',
    brief: '',
    references: [{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      buffer: ONE_PIXEL_PNG,
    }],
    runsRoot: path.join(root, 'runs'),
  };
  const provider = {
    chatJson: async () => ({
      json: {
        visualDesign: visualDesignFixture(),
        pages: [{ name: 'Home', route: '/', referenceImage: null }],
      },
    }),
    chat: async () => {
      buildCalls += 1;
      throw new Error('builder should not run');
    },
  };

  try {
    const result = await runPipeline({ targetDir, config, provider });
    const events = await fs.readFile(path.join(result.runDir, 'logs', 'events.jsonl'), 'utf8');
    assert.equal(result.status, 'failed');
    assert.equal(buildCalls, 0);
    assert.match(events, /"type":"fatal".*"code":"VISUAL_PLAN_INVALID"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function visualDesignFixture() {
  return {
    layout: 'single page',
    palette: ['#ffffff'],
    typography: 'sans serif',
    spacing: '16px rhythm',
    components: ['Header'],
    responsive: 'fluid layout',
  };
}

test('provider retries transient gateway failures', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('gateway timeout', { status: 504, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const provider = createProvider({
    apiKey: 'test-key',
    baseUrl: 'http://stub.local/v1',
    model: 'stub',
    temperature: 0,
    maxNetworkRetries: 1,
    requestTimeoutMs: 1000,
  });
  const result = await provider.chat({ user: 'hello' });

  assert.equal(result.content, 'ok');
  assert.equal(calls, 2);
});

test('provider collects streamed chat completions across SSE chunks', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"model":"stub","choices":[{"delta":{"content":"Hel'));
        controller.enqueue(encoder.encode('lo "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const provider = createProvider({
    apiKey: 'test-key',
    baseUrl: 'http://stub.local/v1',
    model: 'stub',
    temperature: 0,
    maxNetworkRetries: 0,
    requestTimeoutMs: 1000,
  });
  const result = await provider.chat({ user: 'hello' });

  assert.equal(requestBody.stream, true);
  assert.equal(result.content, 'Hello world');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test('streaming requests use a longer timeout than non-streaming requests', () => {
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000 }, false), 120_000);
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000 }, true), 600_000);
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000, streamRequestTimeoutMs: 300_000 }, true), 300_000);
});

test('parseFileBlocks handles the delimiter protocol with tricky content', () => {
  // Content deliberately contains quotes, backslashes, braces, and a JSON blob -
  // exactly what breaks a JSON-string transport but is fine for delimited raw text.
  const out = `=== FILE: index.html
<div id="root"></div>
=== END ===
=== FILE: src/App.jsx
const s = "he said \\"hi\\"";
const re = /\\d+/;
const obj = { a: 1, b: "}" };
=== END ===`;
  const files = parseFileBlocks(out);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'index.html');
  assert.match(files[0].content, /<div id="root">/);
  assert.equal(files[1].path, 'src/App.jsx');
  assert.match(files[1].content, /he said/);
  assert.match(files[1].content, /\{ a: 1, b: "\}" \}/);
});

test('parseFileBlocks strips an outer markdown fence', () => {
  const out = '```\n=== FILE: a.js\nconsole.log(1);\n=== END ===\n```';
  const files = parseFileBlocks(out);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.js');
  assert.match(files[0].content, /console\.log\(1\)/);
});

test('parseFileBlocks ignores empty or markerless output', () => {
  assert.equal(parseFileBlocks('just some prose, no markers').length, 0);
  assert.equal(parseFileBlocks('=== FILE: empty.js\n\n=== END ===').length, 0);
});

const okShot = { page: 'Home', route: '/', bytes: 60_000, text: 'x'.repeat(100), file: 'home.png' };

test('review passes only when everything is green', () => {
  const spec = { pages: [{ name: 'Home', route: '/' }] };
  const good = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec });
  assert.equal(good.pass, true);

  const badBuild = review({ install: { exitCode: 0 }, build: { exitCode: 1 }, shots: [okShot], spec });
  assert.equal(badBuild.pass, false);

  const emptyShot = review({
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [{ ...okShot, bytes: 100, text: '' }],
    spec,
  });
  assert.equal(emptyShot.pass, false);

  const missingPage = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [], spec });
  assert.equal(missingPage.pass, false);
});

test('review requires mapped visual comparisons to meet threshold', () => {
  const spec = {
    pages: [{ name: 'Home', route: '/', referenceImage: 'home.png' }],
  };
  const base = {
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [okShot],
    spec,
    scenarioResults: [],
  };
  const fail = review({
    ...base,
    visualResults: [{
      page: 'Home',
      referenceImage: 'home.png',
      score: 0.4,
      structure: 0.5,
      color: 0.2,
      threshold: 0.62,
      pass: false,
    }],
  });
  const pass = review({
    ...base,
    visualResults: [{
      page: 'Home',
      referenceImage: 'home.png',
      score: 0.8,
      structure: 0.8,
      color: 0.8,
      threshold: 0.62,
      pass: true,
    }],
  });

  assert.equal(fail.pass, false);
  assert.equal(pass.pass, true);
});

test('review enforces mustContain page content', () => {
  const spec = { pages: [{ name: 'Home', route: '/', mustContain: ['本月支出', '¥'] }] };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 } };

  const good = review({ ...base, shots: [{ ...okShot, text: '本月支出 ¥1234 记一笔' + 'x'.repeat(50) }], spec });
  assert.equal(good.pass, true);

  const missing = review({ ...base, shots: [{ ...okShot, text: 'hello world' + 'x'.repeat(50) }], spec });
  assert.equal(missing.pass, false);
  assert.ok(missing.failed.some((c) => c.name.includes('本月支出')));
});

test('review enforces interaction scenarios', () => {
  const spec = {
    pages: [{ name: 'Home', route: '/' }],
    scenarios: [{ name: 'add expense shows new row', route: '/', steps: [], expectText: '新记录' }],
  };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec };

  const pass = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: true }] });
  assert.equal(pass.pass, true);

  const fail = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: false, error: 'text not found' }] });
  assert.equal(fail.pass, false);

  const notRun = review({ ...base, scenarioResults: [] });
  assert.equal(notRun.pass, false);
});

test('describeFailure includes build stderr and failed checks', () => {
  const text = describeFailure({
    install: { exitCode: 0 },
    build: { exitCode: 1, stderr: 'SyntaxError: unexpected token' },
    shots: [],
    reviewResult: { failed: [{ name: 'npm run build passes', detail: 'exit=1' }] },
  });
  assert.match(text, /BUILD FAILED/);
  assert.match(text, /SyntaxError/);
  assert.match(text, /REVIEW CHECKS FAILED/);
});

test('gatherSource collects app source and skips scaffold + node_modules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-src-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'react'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), '{"scaffold":true}');
  await fs.writeFile(path.join(dir, 'src', 'App.jsx'), 'export default function App(){}');
  await fs.writeFile(path.join(dir, 'node_modules', 'react', 'index.js'), 'module.exports={}');

  const out = await gatherSource(dir);
  assert.match(out, /=== FILE: src\/App\.jsx/);
  assert.match(out, /export default function App/);
  assert.doesNotMatch(out, /scaffold/); // package.json excluded
  assert.doesNotMatch(out, /node_modules/); // deps excluded

  await fs.rm(dir, { recursive: true, force: true });
});

test('visual repair content includes diagnostics, reference, and generated screenshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-visual-fix-'));
  const reference = path.join(root, 'reference.png');
  const actual = path.join(root, 'actual.png');
  await fs.writeFile(reference, ONE_PIXEL_PNG);
  await fs.writeFile(actual, ONE_PIXEL_PNG);

  try {
    const content = await createFixerUserContent({
      round: 1,
      failure: 'visual similarity failed',
      source: '=== FILE: src/App.jsx\nexport default 1\n=== END ===',
      visualFailures: [{
        page: 'Home',
        referenceFile: reference,
        actualFile: actual,
        referenceType: 'image/png',
        score: 0.4,
        threshold: 0.62,
      }],
    });

    assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
    assert.match(content[0].text, /visual similarity failed/);
    assert.match(content[1].text, /Home.*0\.4.*0\.62/s);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('delivery report records input references and visual score history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-visual-report-'));
  const privateEndpoint = 'https://private.invalid/v1';
  const privatePath = 'D:\\private\\vibe-secret\\artifact.txt';
  const ctx = {
    runId: 'visual-run',
    runDir: root,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) {
      this.events.push({ type, ...data });
    },
  };
  const config = {
    model: 'stub',
    baseUrl: privateEndpoint,
    stack: 'react-vite',
    maxRepairRounds: 1,
    references: [{ name: 'home.png', width: 390, height: 844, type: 'image/png' }],
  };
  const visualHistory = [
    { round: 0, results: [{ page: 'Home', score: 0.54, threshold: 0.62, structure: 0.61, color: 0.3767, pass: false }] },
    { round: 1, results: [{ page: 'Home', score: 0.7812, threshold: 0.62, structure: 0.79, color: 0.7607, pass: true }] },
  ];

  await writeReport(ctx, {
    config,
    spec: { summary: 'Visual app' },
    status: 'success',
    rounds: 1,
    finalReview: { checks: [] },
    shots: [],
    scenarioResults: [],
    visualHistory,
    error: new Error(`upstream ${privateEndpoint} failed at ${privatePath}`),
  });
  const report = await fs.readFile(path.join(root, 'DELIVERY_REPORT.md'), 'utf8');
  const events = JSON.stringify(ctx.events);

  assert.match(report, /## Input references/);
  assert.match(report, /home\.png.*390x844.*image\/png/);
  assert.match(report, /### Round 0[\s\S]*0\.5400 \/ 0\.6200/);
  assert.match(report, /### Round 1[\s\S]*0\.7812 \/ 0\.6200/);
  assert.doesNotMatch(report, /Visual similarity to any reference is not scored/);
  assert.doesNotMatch(report, /private\.invalid|vibe-secret/);
  assert.doesNotMatch(events, /vibe-visual-report-|vibe-secret|private\.invalid/);
  await fs.rm(root, { recursive: true, force: true });
});

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

test('run context copies reference evidence into the run directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-reference-'));
  const targetDir = path.join(root, 'target');
  const inputDir = path.join(targetDir, 'input');
  const referencesDir = path.join(inputDir, 'references');
  await fs.mkdir(referencesDir, { recursive: true });
  await fs.writeFile(path.join(referencesDir, 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(referencesDir, 'manifest.json'),
    JSON.stringify([{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );

  const ctx = await createRunContext(targetDir, {
    runsRoot: path.join(root, 'runs'),
    inputDir,
  });

  assert.deepEqual(await fs.readFile(path.join(ctx.referencesDir, 'home.png')), ONE_PIXEL_PNG);
  assert.equal((await fs.stat(ctx.visualDir)).isDirectory(), true);
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

test('reference images validate magic bytes, dimensions, names, and limits', () => {
  const refs = normalizeReferencePayloads([{
    name: '../Home Screen.PNG',
    type: 'image/png',
    width: 1,
    height: 1,
    base64: ONE_PIXEL_PNG.toString('base64'),
  }]);
  assert.deepEqual(refs.map(({ name, type, width, height }) => ({ name, type, width, height })), [{
    name: 'home-screen.png', type: 'image/png', width: 1, height: 1,
  }]);
  assert.throws(
    () => normalizeReferencePayloads([{
      name: 'bad.png',
      type: 'image/png',
      width: 1,
      height: 1,
      base64: Buffer.from('not-png').toString('base64'),
    }]),
    /REFERENCE_INVALID/,
  );
  assert.throws(
    () => normalizeReferencePayloads(Array.from(
      { length: REFERENCE_LIMITS.maxFiles + 1 },
      (_, i) => ({
        name: `${i}.png`,
        type: 'image/png',
        width: 1,
        height: 1,
        base64: ONE_PIXEL_PNG.toString('base64'),
      }),
    )),
    /REFERENCE_COUNT_EXCEEDED/,
  );
});

test('reference images persist and loadConfig accepts screenshot-only input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-reference-'));
  await fs.mkdir(path.join(root, 'input'), { recursive: true });
  const refs = normalizeReferencePayloads([{
    name: 'home.png',
    type: 'image/png',
    width: 1,
    height: 1,
    base64: ONE_PIXEL_PNG.toString('base64'),
  }]);
  await writeReferencePayloads(path.join(root, 'input'), refs);
  const discovered = await discoverReferenceImages(path.join(root, 'input'));
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'home.png');
  const config = await loadConfig(root, { apiKey: 'session-secret' });
  assert.equal(config.brief, '');
  assert.equal(config.references.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('reference discovery rejects manifest paths outside the references directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-reference-jail-'));
  const inputDir = path.join(root, 'input');
  const referencesDir = path.join(inputDir, 'references');
  await fs.mkdir(referencesDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'outside.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(referencesDir, 'manifest.json'),
    JSON.stringify([{
      name: '../outside.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );

  await assert.rejects(discoverReferenceImages(inputDir), /REFERENCE_PATH_INVALID/);
  await fs.rm(root, { recursive: true, force: true });
});
