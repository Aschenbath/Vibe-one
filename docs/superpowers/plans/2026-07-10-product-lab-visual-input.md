# Product Lab Visual Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an all-Chinese Product Lab console that turns text and/or reference screenshots into a verified responsive React product, including deterministic visual comparison and bounded visual repair.

**Architecture:** Extend the existing single-provider pipeline instead of creating a second generation path. Reference images are validated once, stored in jailed input/run directories, sent to the planner as OpenAI-compatible multimodal content, mapped to generated pages, compared locally against Playwright viewport captures, and included in the existing mechanical reviewer/fixer/report loop. The console remains a loopback-only thin client and changes from a persistent three-column shell to a Focus → Flow workspace.

**Tech Stack:** Node.js 20 ESM, OpenAI-compatible Chat Completions/SSE, React 18 + Vite generated targets, Playwright/Canvas, native HTML/CSS/JavaScript console, `node:test`.

---

## File map

### New files

- `src/core/referenceImages.js` — validate/decode uploads, inspect PNG/JPEG/WebP dimensions, persist/discover jailed reference images, build data URLs.
- `src/runner/visualCompare.js` — decode images through Playwright canvas and compute deterministic structural/color scores.
- `src/console/public/copy.js` — Chinese status, stage, event, and error copy.
- `src/console/public/reference-input.js` — browser reference-file selection, preview, ordering, removal, and JSON payload creation.
- `test/visual.test.js` — deterministic image scoring and visual comparison contracts.

### Modified engine files

- `src/core/config.js` — permit screenshot-only inputs and expose discovered references.
- `src/core/runContext.js` — create/copy `references/` and `visual/` evidence directories.
- `src/providers/openaiCompatible.js` — accept string or multimodal user content without regressing streaming/fallback/retries.
- `src/core/planner.js` — send multimodal input and persist structured visual design/reference mapping.
- `src/runner/commands.js` — capture both full-page evidence and reference-sized comparison screenshots.
- `src/core/reviewer.js` — make visual thresholds part of the mechanical success gate.
- `src/core/fixer.js` — send reference/current screenshots when visual checks fail.
- `src/core/pipeline.js` — carry visual results/history through verification and repair rounds.
- `src/reporter/deliveryReport.js` — record input mode, reference mapping, visual scores, and score history.

### Modified console files

- `src/console/jobManager.js` — accept text and/or image input, persist references, expose only safe reference metadata.
- `src/console/runStore.js` — list/serve reference evidence and structured visual comparisons.
- `src/console/server.js` — add reference routes, visual data routes, larger `/api/jobs` body limit, and static ESM modules.
- `src/console/public/index.html` — all-Chinese Product Lab Focus → Flow markup.
- `src/console/public/app.js` — module-based orchestration, Chinese rendering, Focus → Flow transitions, evidence views.
- `src/console/public/app.css` — Product Lab visual system and responsive/accessibility states.

### Modified tests/docs

- `test/core.test.js`, `test/console.test.js`, `test/e2e.test.js`, `test/console-e2e.test.js`.
- `README.md`, `FRAMEWORK.md`, `docs/architecture.md`, `docs/HANDOFF.md`, `history.md`.
- `docs/screenshots/console-desktop.png`, `docs/screenshots/console-mobile.png`.

---

## Phase 1 — Reference images enter the trusted pipeline

### Task 1: Reference image validation and config discovery

**Files:**
- Create: `src/core/referenceImages.js`
- Modify: `src/core/config.js`
- Modify: `test/core.test.js`

- [ ] **Step 1: Write failing reference-image tests**

Add imports and tests to `test/core.test.js`:

```js
import {
  REFERENCE_LIMITS,
  normalizeReferencePayloads,
  writeReferencePayloads,
  discoverReferenceImages,
} from '../src/core/referenceImages.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('reference images validate magic bytes, dimensions, names, and limits', async () => {
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
  assert.throws(() => normalizeReferencePayloads([{ name: 'bad.png', type: 'image/png', width: 1, height: 1, base64: Buffer.from('not-png').toString('base64') }]), /REFERENCE_INVALID/);
  assert.throws(() => normalizeReferencePayloads(Array.from({ length: REFERENCE_LIMITS.maxFiles + 1 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', width: 1, height: 1, base64: ONE_PIXEL_PNG.toString('base64') }))), /REFERENCE_COUNT_EXCEEDED/);
});

test('reference images persist and loadConfig accepts screenshot-only input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-reference-'));
  await fs.mkdir(path.join(root, 'input'), { recursive: true });
  const refs = normalizeReferencePayloads([{ name: 'home.png', type: 'image/png', width: 1, height: 1, base64: ONE_PIXEL_PNG.toString('base64') }]);
  await writeReferencePayloads(path.join(root, 'input'), refs);
  const discovered = await discoverReferenceImages(path.join(root, 'input'));
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'home.png');
  const config = await loadConfig(root, { apiKey: 'session-secret' });
  assert.equal(config.brief, '');
  assert.equal(config.references.length, 1);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/core.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/core/referenceImages.js`.

- [ ] **Step 3: Implement `src/core/referenceImages.js`**

Create the module with this public API and limits:

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export const REFERENCE_LIMITS = Object.freeze({
  maxFiles: 4,
  maxFileBytes: 6 * 1024 * 1024,
  maxTotalBytes: 18 * 1024 * 1024,
  minDimension: 1,
  maxDimension: 4096,
});

const TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

export function normalizeReferencePayloads(payloads = []) {
  if (!Array.isArray(payloads)) throw coded('REFERENCE_INVALID', 'references must be an array');
  if (payloads.length > REFERENCE_LIMITS.maxFiles) throw coded('REFERENCE_COUNT_EXCEEDED', `at most ${REFERENCE_LIMITS.maxFiles} reference images are allowed`);
  let total = 0;
  const names = new Set();
  return payloads.map((payload, index) => {
    const type = String(payload?.type ?? '').toLowerCase();
    const ext = TYPES.get(type);
    if (!ext) throw coded('REFERENCE_TYPE_UNSUPPORTED', `unsupported reference type: ${type || '(empty)'}`);
    const buffer = decodeBase64(payload?.base64);
    if (buffer.length > REFERENCE_LIMITS.maxFileBytes) throw coded('REFERENCE_TOO_LARGE', `reference ${index + 1} exceeds 6 MiB`);
    total += buffer.length;
    if (total > REFERENCE_LIMITS.maxTotalBytes) throw coded('REFERENCE_TOTAL_EXCEEDED', 'reference images exceed 18 MiB total');
    const actual = readImageDimensions(buffer, type);
    const claimedWidth = Number(payload?.width);
    const claimedHeight = Number(payload?.height);
    if (actual.width !== claimedWidth || actual.height !== claimedHeight) throw coded('REFERENCE_DIMENSION_MISMATCH', 'reference dimensions do not match file content');
    if (actual.width < REFERENCE_LIMITS.minDimension || actual.height < REFERENCE_LIMITS.minDimension || actual.width > REFERENCE_LIMITS.maxDimension || actual.height > REFERENCE_LIMITS.maxDimension) throw coded('REFERENCE_DIMENSION_INVALID', 'reference dimensions are outside 1..4096');
    let name = sanitizeName(payload?.name, index, ext);
    for (let suffix = 2; names.has(name); suffix++) name = `${path.basename(name, ext)}-${suffix}${ext}`;
    names.add(name);
    return { name, type, width: actual.width, height: actual.height, bytes: buffer.length, buffer };
  });
}

export async function writeReferencePayloads(inputDir, references) {
  const dir = path.join(inputDir, 'references');
  await fs.mkdir(dir, { recursive: true });
  for (const ref of references) await fs.writeFile(path.join(dir, ref.name), ref.buffer);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(references.map(({ name, type, width, height, bytes }) => ({ name, type, width, height, bytes })), null, 2), 'utf8');
}

export async function discoverReferenceImages(inputDir) {
  const dir = path.join(inputDir, 'references');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(manifest.map(async (item) => ({ ...item, file: path.join(dir, item.name), buffer: await fs.readFile(path.join(dir, item.name)) })));
}

export function referenceContentPart(reference) {
  return { type: 'image_url', image_url: { url: `data:${reference.type};base64,${reference.buffer.toString('base64')}` } };
}
```

In the same file implement `decodeBase64`, `sanitizeName`, `coded`, and `readImageDimensions`:

```js
function decodeBase64(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw coded('REFERENCE_INVALID', 'reference base64 is invalid');
  return Buffer.from(text, 'base64');
}

function sanitizeName(value, index, ext) {
  const stem = path.basename(String(value || `reference-${index + 1}`), path.extname(String(value || '')))
    .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `${stem || `reference-${index + 1}`}${ext}`;
}

function coded(code, message) { const error = new Error(`${code}: ${message}`); error.code = code; return error; }

function readImageDimensions(buffer, type) {
  if (type === 'image/png') {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw coded('REFERENCE_INVALID', 'PNG signature is invalid');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (type === 'image/jpeg') {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw coded('REFERENCE_INVALID', 'JPEG signature is invalid');
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw coded('REFERENCE_INVALID', 'JPEG dimensions are missing');
  }
  if (type === 'image/webp') {
    if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw coded('REFERENCE_INVALID', 'WebP signature is invalid');
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === 'VP8L') { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    throw coded('REFERENCE_INVALID', 'WebP dimensions are missing');
  }
  throw coded('REFERENCE_TYPE_UNSUPPORTED', `unsupported reference type: ${type}`);
}
```

- [ ] **Step 4: Make `loadConfig` accept text and/or screenshots**

In `src/core/config.js`, import `discoverReferenceImages`, read missing `brief.md` as `''`, discover references, and reject only when both are absent:

```js
// Add beside the existing request/repair defaults:
visualThreshold: Number(process.env.VIBE_ONE_VISUAL_THRESHOLD) || 0.62,

const brief = await fs.readFile(briefPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
const references = await discoverReferenceImages(inputDir);
if (!brief.trim() && references.length === 0) throw new Error('INPUT_REQUIRED: provide brief text or at least one reference image');
const apiKey = overrides.apiKey || process.env.VIBE_ONE_API_KEY;
if (!apiKey) throw new Error('VIBE_ONE_API_KEY is not set (see .env.example)');
return { ...DEFAULTS, ...constraints, apiKey, brief, references, inputDir };
```

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/core.test.js`

Expected: all core tests pass.

Commit:

```bash
git add src/core/referenceImages.js src/core/config.js test/core.test.js
git commit -m "feat: validate reference image inputs"
```

### Task 2: Console ingestion, jailed persistence, and safe public metadata

**Files:**
- Modify: `src/console/jobManager.js`
- Modify: `src/console/server.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Write failing console input tests**

Add tests that start a screenshot-only job, confirm the 26 MiB route limit is passed to `readJson`, and verify no base64/key/path leaks:

```js
test('a screenshot-only job persists references without exposing base64 or secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-reference-'));
  let loaded;
  const manager = createJobManager({
    runsRoot: root,
    env: { VIBE_ONE_API_KEY: 'secret-key' },
    load: async (targetDir, overrides) => { loaded = await loadConfig(targetDir, overrides); return { ...loaded, model: 'stub', baseUrl: 'local' }; },
    pipeline: async ({ config }) => ({ runId: 'run-1', runDir: root, status: config.references.length ? 'planned' : 'failed' }),
  });
  const payload = { name: 'home.png', type: 'image/png', width: 1, height: 1, base64: ONE_PIXEL_PNG.toString('base64') };
  const job = await manager.startJob({ title: 'Screenshot clone', brief: '', references: [payload], mode: 'plan' });
  await manager.waitForJob(job.id);
  const publicJob = manager.getJob(job.id);
  assert.equal(publicJob.referenceCount, 1);
  assert.deepEqual(publicJob.references, ['home.png']);
  assert.doesNotMatch(JSON.stringify(publicJob), /secret-key|iVBOR/);
  assert.equal(loaded.references.length, 1);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/console.test.js`

Expected: FAIL because `startJob` still requires brief text and ignores `references`.

- [ ] **Step 3: Implement console ingestion**

In `src/console/jobManager.js` import `normalizeReferencePayloads` and `writeReferencePayloads`. Replace brief-only validation with:

```js
const brief = String(input.brief ?? '').trim();
if (brief.length > 100_000) throw new ConsoleError('BRIEF_TOO_LARGE', '需求描述不能超过 100,000 个字符。', 413);
let references;
try { references = normalizeReferencePayloads(input.references ?? []); }
catch (error) { throw new ConsoleError(error.code || 'REFERENCE_INVALID', error.message.replace(/^[A-Z_]+:\s*/, ''), 422); }
if (!brief && references.length === 0) throw new ConsoleError('INPUT_REQUIRED', '请填写需求描述或上传至少一张参考图。', 422);
```

After creating `input/`, write `brief.md` only when text is present and call:

```js
if (brief) await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief, 'utf8');
await writeReferencePayloads(path.join(targetDir, 'input'), references);
```

Store only safe metadata on the live job:

```js
references: references.map((ref) => ref.name),
referenceCount: references.length,
inputMode: brief && references.length ? 'text+images' : references.length ? 'images' : 'text',
```

Return those three fields from `publicJob`; never store `buffer` or `base64` on `job`.

- [ ] **Step 4: Apply the route-specific request cap**

In `src/console/server.js` change only job creation:

```js
const JOB_BODY_LIMIT = 26 * 1024 * 1024;
if (pathname === '/api/jobs' && req.method === 'POST') {
  return sendJson(res, 202, await jobs.startJob(await readJson(req, { maxBytes: JOB_BODY_LIMIT })));
}
```

Keep `readJson` default at 1,000,000 bytes for every other API route.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/console.test.js`

Expected: all console tests pass.

Commit:

```bash
git add src/console/jobManager.js src/console/server.js test/console.test.js
git commit -m "feat: ingest screenshot references safely"
```

### Task 3: Persist references with each run

**Files:**
- Modify: `src/core/runContext.js`
- Modify: `test/core.test.js`

- [ ] **Step 1: Write a failing run-evidence test**

```js
test('run context copies reference evidence into the run directory', async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-reference-'));
  const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-runs-'));
  await fs.mkdir(path.join(target, 'input', 'references'), { recursive: true });
  await fs.writeFile(path.join(target, 'input', 'references', 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(target, 'input', 'references', 'manifest.json'), JSON.stringify([{ name: 'home.png', type: 'image/png', width: 1, height: 1, bytes: ONE_PIXEL_PNG.length }]));
  const ctx = await createRunContext(target, { runsRoot, inputDir: path.join(target, 'input') });
  assert.deepEqual(await fs.readFile(path.join(ctx.referencesDir, 'home.png')), ONE_PIXEL_PNG);
  assert.equal((await fs.stat(ctx.visualDir)).isDirectory(), true);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/core.test.js`

Expected: FAIL because `referencesDir` and `visualDir` do not exist.

- [ ] **Step 3: Extend the run context**

Add `referencesDir` and `visualDir` to `dirs`, then copy the source directory after creating directories:

```js
referencesDir: path.join(runDir, 'references'),
visualDir: path.join(runDir, 'visual'),
```

```js
const sourceReferences = path.join(config.inputDir || path.join(targetDir, 'input'), 'references');
try { await fs.cp(sourceReferences, dirs.referencesDir, { recursive: true, force: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
```

- [ ] **Step 4: Run GREEN and commit**

Run: `node --test test/core.test.js`

Expected: all core tests pass.

Commit:

```bash
git add src/core/runContext.js test/core.test.js
git commit -m "feat: preserve reference evidence per run"
```

---

## Phase 2 — Multimodal planning, deterministic comparison, and visual repair

### Task 4: OpenAI-compatible multimodal planner input

**Files:**
- Modify: `src/providers/openaiCompatible.js`
- Modify: `src/core/planner.js`
- Modify: `test/core.test.js`

- [ ] **Step 1: Write failing provider/planner tests**

```js
test('provider preserves OpenAI-compatible multimodal user content', async (t) => {
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = createProvider({ model: 'vision-model', baseUrl: 'http://local/v1', apiKey: 'x', temperature: 0, streamResponses: false, maxNetworkRetries: 0 });
  const content = [{ type: 'text', text: 'Clone this UI' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
  await provider.chatJson({ system: 'system', user: content });
  assert.deepEqual(requestBody.messages[1].content, content);
});

test('planner content includes reference images and visual schema instructions', () => {
  const content = createPlannerUserContent({ brief: '做一个记账产品', references: [{ name: 'home.png', type: 'image/png', width: 390, height: 844, buffer: ONE_PIXEL_PNG }] });
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /home\.png.*390x844/s);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(PLANNER_SYSTEM, /visualDesign/);
  assert.match(PLANNER_SYSTEM, /referenceImage/);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/core.test.js`

Expected: FAIL because planner helpers are not exported and its system prompt lacks visual fields.

- [ ] **Step 3: Harden provider content normalization**

In `src/providers/openaiCompatible.js`, add and use:

```js
function normalizeUserContent(user) {
  if (typeof user === 'string') return user;
  if (!Array.isArray(user) || user.length === 0) throw new Error('model user content must be a string or non-empty content array');
  return user.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return { type: 'image_url', image_url: { url: part.image_url.url } };
    throw new Error('model user content contains an unsupported part');
  });
}
```

Set the user message to `{ role: 'user', content: normalizeUserContent(user) }`. Do not change retries, streaming, timeout resolution, usage collection, or JSON fallback.

Track `const multimodal = Array.isArray(body.messages.at(-1).content) && body.messages.at(-1).content.some((part) => part.type === 'image_url')`. In the existing non-OK branch, after reading the response text, convert a 400/415/422 response mentioning `image`, `vision`, `multimodal`, or `content` into:

```js
const error = new Error(`VISION_UNSUPPORTED: ${text.slice(0, 500) || `HTTP ${res.status}`}`);
error.code = 'VISION_UNSUPPORTED';
throw error;
```

Other HTTP failures keep the existing error behavior.

- [ ] **Step 4: Add visual fields to planner output**

Rename/export the prompt as `PLANNER_SYSTEM` and require:

```text
visualDesign: { layout: string, palette: [string], typography: string, spacing: string, components: [string], responsive: string }
pages: [{ name, route, purpose, mustContain, referenceImage: string|null }]
```

Export and use:

```js
export function createPlannerUserContent(config) {
  const references = config.references ?? [];
  if (!references.length) return config.brief;
  const text = [
    'Product brief:', config.brief || '(no text brief; infer the product from the reference images)', '',
    'Reference images:',
    ...references.map((ref, index) => `${index + 1}. ${ref.name} (${ref.width}x${ref.height}, ${ref.type})`),
    '',
    'Map each image to the closest planned page using pages[].referenceImage. Use null when a page has no reference.',
  ].join('\n');
  return [{ type: 'text', text }, ...references.map(referenceContentPart)];
}
```

Use it in `plan()` and render visual design/reference mapping into `SPEC.generated.md` and `PLAN.generated.md`.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/core.test.js`

Expected: all core tests pass.

Commit:

```bash
git add src/providers/openaiCompatible.js src/core/planner.js test/core.test.js
git commit -m "feat: plan products from reference images"
```

### Task 5: Deterministic visual scorer

**Files:**
- Create: `src/runner/visualCompare.js`
- Create: `test/visual.test.js`

- [ ] **Step 1: Write RED scoring tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePixelSamples } from '../src/runner/visualCompare.js';

const solid = (r, g, b, count = 64) => Uint8Array.from(Array.from({ length: count }, () => [r, g, b, 255]).flat());

test('visual scoring is deterministic and rewards structural/color identity', () => {
  const white = solid(255, 255, 255);
  const black = solid(0, 0, 0);
  const same = scorePixelSamples(white, white);
  const different = scorePixelSamples(white, black);
  assert.equal(same.score, 1);
  assert.equal(same.structure, 1);
  assert.equal(same.color, 1);
  assert.ok(different.score < 0.15, JSON.stringify(different));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/visual.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure scoring**

Create `src/runner/visualCompare.js` with:

```js
import fs from 'node:fs/promises';

export const DEFAULT_VISUAL_THRESHOLD = 0.62;

export function scorePixelSamples(reference, actual) {
  if (reference.length !== actual.length || reference.length % 4 !== 0) throw new Error('visual samples must have equal RGBA lengths');
  const refGray = [];
  const actualGray = [];
  const refHist = Array(12).fill(0);
  const actualHist = Array(12).fill(0);
  for (let i = 0; i < reference.length; i += 4) {
    refGray.push(gray(reference[i], reference[i + 1], reference[i + 2]));
    actualGray.push(gray(actual[i], actual[i + 1], actual[i + 2]));
    addHistogram(refHist, reference, i);
    addHistogram(actualHist, actual, i);
  }
  const structure = clamp(ssim(refGray, actualGray));
  const color = clamp(1 - refHist.reduce((sum, value, index) => sum + Math.abs(value - actualHist[index]), 0) / (6 * refGray.length));
  return { structure: round(structure), color: round(color), score: round(structure * 0.7 + color * 0.3) };
}

function gray(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function addHistogram(hist, pixels, offset) { hist[Math.floor(pixels[offset] / 64)] += 1; hist[4 + Math.floor(pixels[offset + 1] / 64)] += 1; hist[8 + Math.floor(pixels[offset + 2] / 64)] += 1; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function ssim(a, b) {
  const ma = mean(a), mb = mean(b);
  let va = 0, vb = 0, cov = 0;
  for (let i = 0; i < a.length; i++) { va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb); }
  const divisor = Math.max(a.length - 1, 1);
  va /= divisor; vb /= divisor; cov /= divisor;
  const c1 = 6.5025, c2 = 58.5225;
  return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma ** 2 + mb ** 2 + c1) * (va + vb + c2));
}
function clamp(value) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function round(value) { return Math.round(value * 10_000) / 10_000; }
```

- [ ] **Step 4: Add Playwright/Canvas decoding**

Export:

```js
export async function compareImageFiles(page, { referenceFile, actualFile, sampleSize = 96 }) {
  const [referenceBytes, actualBytes] = await Promise.all([fs.readFile(referenceFile), fs.readFile(actualFile)]);
  const samples = await page.evaluate(async ({ referenceUrl, actualUrl, size }) => {
    const load = (src) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const sample = async (src) => {
      const image = await load(src);
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    };
    return { reference: await sample(referenceUrl), actual: await sample(actualUrl) };
  }, {
    referenceUrl: `data:image/${referenceFile.toLowerCase().endsWith('.png') ? 'png' : referenceFile.toLowerCase().endsWith('.webp') ? 'webp' : 'jpeg'};base64,${referenceBytes.toString('base64')}`,
    actualUrl: `data:image/png;base64,${actualBytes.toString('base64')}`,
    size: sampleSize,
  });
  return scorePixelSamples(Uint8Array.from(samples.reference), Uint8Array.from(samples.actual));
}
```

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/visual.test.js`

Expected: all visual tests pass.

Commit:

```bash
git add src/runner/visualCompare.js test/visual.test.js
git commit -m "feat: score visual similarity locally"
```

### Task 6: Capture, review, and persist visual comparisons

**Files:**
- Modify: `src/runner/commands.js`
- Modify: `src/core/reviewer.js`
- Modify: `src/core/pipeline.js`
- Modify: `src/console/jobManager.js`
- Modify: `test/core.test.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Write RED reviewer/pipeline tests**

```js
test('review requires mapped visual comparisons to meet threshold', () => {
  const visualSpec = { ...spec, pages: [{ ...spec.pages[0], referenceImage: 'home.png' }] };
  const pageName = visualSpec.pages[0].name;
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec: visualSpec, scenarioResults: [] };
  const fail = review({ ...base, visualResults: [{ page: pageName, referenceImage: 'home.png', score: 0.4, structure: 0.5, color: 0.2, threshold: 0.62, pass: false }] });
  assert.equal(fail.pass, false);
  const pass = review({ ...base, visualResults: [{ page: pageName, referenceImage: 'home.png', score: 0.8, structure: 0.8, color: 0.8, threshold: 0.62, pass: true }] });
  assert.equal(pass.pass, true);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/core.test.js`

Expected: FAIL because visual results are ignored.

- [ ] **Step 3: Add reference viewport captures**

In `src/runner/commands.js`, keep the existing full-page screenshot and add an optional viewport capture for mapped pages. Export `compareReferencePages`:

```js
export async function compareReferencePages(ctx, baseUrl, pages, references, threshold = DEFAULT_VISUAL_THRESHOLD) {
  const mapped = pages.filter((page) => page.referenceImage);
  if (!mapped.length) return [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const planned of mapped) {
      const reference = references.find((item) => item.name === planned.referenceImage);
      if (!reference) { results.push({ page: planned.name, referenceImage: planned.referenceImage, pass: false, score: 0, structure: 0, color: 0, threshold, error: 'mapped reference missing' }); continue; }
      const page = await browser.newPage({ viewport: { width: reference.width, height: reference.height } });
      try {
        const route = planned.route?.startsWith('/') ? planned.route : `/${planned.route ?? ''}`;
        await page.goto(new URL(route, baseUrl).href, { waitUntil: 'networkidle', timeout: 30_000 });
        const actualName = `visual-${slug(planned.name)}.png`;
        const actualFile = path.join(ctx.screenshotsDir, actualName);
        await page.screenshot({ path: actualFile, fullPage: false });
        const scores = await compareImageFiles(page, { referenceFile: reference.file, actualFile });
        const result = { page: planned.name, route, referenceImage: reference.name, actualImage: actualName, threshold, ...scores, pass: scores.score >= threshold };
        results.push(result);
        await ctx.logEvent('visual:compare', { summary: `${planned.name}: ${scores.score.toFixed(3)} / ${threshold.toFixed(2)}` });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  return results;
}
```

- [ ] **Step 4: Gate success and persist round evidence**

Update `review()` to accept `visualResults = []`. For every page with `referenceImage`, require exactly one result and add:

```js
add(`visual similarity: ${page.name}`, !!result && result.pass, result ? `score=${result.score}, threshold=${result.threshold}, structure=${result.structure}, color=${result.color}` : 'visual comparison not executed');
```

In `verifyOnce`, call `compareReferencePages` after page screenshots/scenarios and before review, passing `config.visualThreshold`. Return `visualResults` with the verdict.

In `runPipeline`, keep `visualHistory` and append `{ round: rounds, results: verdict.visualResults }` for each verification pass. Write each round to `visual/round-${rounds}.json` and final history to `visual/comparisons.json` with `fs.writeFile`. When a caught error has `error.code`, include that code in the persisted `fatal` event.

In `jobManager.acceptEvent`, preserve a sanitized `code` field, and make `stageForEvent('visual:compare')` return `visual`. Add a console test whose stub pipeline emits `visual:compare` and assert the live job stage becomes `visual` without exposing secret values.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/core.test.js test/visual.test.js`

Expected: all tests pass.

Commit:

```bash
git add src/runner/commands.js src/core/reviewer.js src/core/pipeline.js src/console/jobManager.js test/core.test.js test/console.test.js
git commit -m "feat: gate delivery on visual evidence"
```

### Task 7: Multimodal visual repair and delivery report

**Files:**
- Modify: `src/core/fixer.js`
- Modify: `src/core/pipeline.js`
- Modify: `src/reporter/deliveryReport.js`
- Modify: `test/core.test.js`

- [ ] **Step 1: Write RED fixer/report tests**

```js
test('visual repair content includes diagnostics, reference, and generated screenshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-visual-fix-'));
  const reference = path.join(root, 'reference.png');
  const actual = path.join(root, 'actual.png');
  await fs.writeFile(reference, ONE_PIXEL_PNG);
  await fs.writeFile(actual, ONE_PIXEL_PNG);
  const content = await createFixerUserContent({ round: 1, failure: 'visual similarity failed', source: '=== FILE: src/App.jsx\nexport default 1\n=== END ===', visualFailures: [{ page: 'Home', referenceFile: reference, actualFile: actual, referenceType: 'image/png', score: 0.4, threshold: 0.62 }] });
  assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
  assert.match(content[0].text, /Home.*0\.4.*0\.62/s);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/core.test.js`

Expected: FAIL because `createFixerUserContent` does not exist.

- [ ] **Step 3: Build multimodal fixer content**

Export an async `createFixerUserContent` from `src/core/fixer.js` that returns the existing text string when `visualFailures` is empty. For visual failures, append a label/reference/current triplet for each page so image ordering remains explicit:

```js
const parts = [{ type: 'text', text: [
  `Repair round ${round}.`, 'Failure evidence:', failure.slice(0, 12_000), '',
  'Current app source:', source, '',
  'Fix each visual failure without breaking the build or verified interactions.',
].join('\n') }];
for (const item of visualFailures) {
  parts.push({ type: 'text', text: `${item.page}: score=${item.score}, threshold=${item.threshold}. Reference image follows, then current generated output.` });
  parts.push(await fileImagePart(item.referenceFile, item.referenceType));
  parts.push(await fileImagePart(item.actualFile, 'image/png'));
}
return parts;
```

Implement `fileImagePart` with `fs.readFile` and a data URL. Change `fix()` to accept `visualFailures = []` and call this helper. Keep the delimiter patch protocol and file safety unchanged.

- [ ] **Step 4: Thread visual failures and update report**

In `pipeline.js`, pass failed comparison entries with resolved `referenceFile` and `actualFile` to `fix`.

Change `writeReport` signature to accept `visualHistory`. Add sections:

```markdown
## Input references
- `home.png` (390x844, image/png)

## Visual comparison history
### Round 0
- [ ] Home: 0.5400 / 0.6200 (structure 0.6100, color 0.3767)
### Round 1
- [x] Home: 0.7812 / 0.6200 (structure 0.7900, color 0.7607)
```

Remove the stale known gap `Visual similarity to any reference is not scored in MVP.`.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/core.test.js test/visual.test.js`

Expected: all tests pass.

Commit:

```bash
git add src/core/fixer.js src/core/pipeline.js src/reporter/deliveryReport.js test/core.test.js
git commit -m "feat: repair apps from visual failures"
```

### Task 8: Real pipeline integration for visual pass and repair

**Files:**
- Modify: `test/e2e.test.js`

- [ ] **Step 1: Add a deterministic visual reference helper**

Add this deterministic helper and use the same HTML/CSS in the successful stub builder:

```js
async function writeVisualReference(targetDir) {
  const dir = path.join(targetDir, 'input', 'references');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'home.png');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#fff;font-family:Arial;color:#111}.hero{height:132px;background:#2457f5;color:#fff;padding:32px 24px}.hero h1{margin:0;font-size:28px}.card{margin:24px;padding:24px;border-radius:20px;background:#ffb547;font-size:22px;font-weight:700}.list{margin:24px;padding:20px;border:1px solid #dce3ef;border-radius:16px}.row{height:52px;border-bottom:1px solid #dce3ef}</style><div class="hero"><h1>自由职业支出</h1></div><div class="card">本月支出 ¥4,820</div><div class="list"><div class="row"></div><div class="row"></div><div class="row"></div></div>`);
    await page.screenshot({ path: file, fullPage: false });
  } finally { await browser.close(); }
  const bytes = (await fs.stat(file)).size;
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify([{ name: 'home.png', type: 'image/png', width: 390, height: 844, bytes }], null, 2));
  return file;
}
```

- [ ] **Step 2: Add a direct-pass visual E2E**

Create an opt-in test where the planner maps `home.png` to `Home`, the builder returns the matching React/CSS app, and the pipeline ends `success` with `visual/comparisons.json` score at or above 0.62.

The provider must assert that the planner call contains an `image_url` part.

- [ ] **Step 3: Add a repair visual E2E**

Create a second provider whose first build uses a black/red theme so visual review fails. On the fixer call, assert there are two `image_url` parts, return the matching blue/amber CSS, and assert round 1 succeeds.

- [ ] **Step 4: Run E2E GREEN**

Run: `$env:VIBE_ONE_E2E='1'; node --test test/e2e.test.js`

Expected: existing normal/repair tests plus the two visual paths pass.

- [ ] **Step 5: Commit**

```bash
git add test/e2e.test.js
git commit -m "test: prove visual generation and repair"
```

---

## Phase 3 — Chinese Product Lab Focus → Flow console

### Task 9: Reference and visual evidence APIs

**Files:**
- Modify: `src/console/runStore.js`
- Modify: `src/console/server.js`
- Modify: `test/console.test.js`

- [ ] **Step 1: Write RED artifact API tests**

Create the run fixture and assertions explicitly:

```js
await fs.mkdir(path.join(runDir, 'references'), { recursive: true });
await fs.mkdir(path.join(runDir, 'visual'), { recursive: true });
await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
await fs.writeFile(path.join(runDir, 'references', 'home.png'), ONE_PIXEL_PNG);
await fs.writeFile(path.join(runDir, 'references', 'manifest.json'), JSON.stringify([{ name: 'home.png', type: 'image/png', width: 1, height: 1, bytes: ONE_PIXEL_PNG.length }]));
await fs.writeFile(path.join(runDir, 'screenshots', 'visual-home.png'), ONE_PIXEL_PNG);
await fs.writeFile(path.join(runDir, 'visual', 'comparisons.json'), JSON.stringify([{ round: 0, results: [{ page: '首页', referenceImage: 'home.png', actualImage: 'visual-home.png', score: 0.8, structure: 0.8, color: 0.8, threshold: 0.62, pass: true }] }]));
const run = await store.getRun(runId);
assert.deepEqual(run.references.map((item) => item.name), ['home.png']);
assert.equal(run.visualComparisons[0].results[0].score, 0.8);
assert.equal((await store.readReference(runId, 'home.png')).type, 'image/png');
await assert.rejects(store.readReference(runId, '../home.png'), /outside|invalid/i);
```

- [ ] **Step 2: Run RED**

Run: `node --test test/console.test.js`

Expected: FAIL because reference/visual store methods do not exist.

- [ ] **Step 3: Extend run store**

Add these methods:

```js
async function readReference(id, name) {
  const dir = jailed(resolveRunDir(id), 'references');
  const manifest = JSON.parse((await readOptional(path.join(dir, 'manifest.json'))) || '[]');
  const item = manifest.find((entry) => entry.name === String(name));
  if (!item) throw new ConsoleError('REFERENCE_NOT_FOUND', 'Reference image not found.', 404);
  return { data: await fs.readFile(jailed(dir, item.name)), type: item.type };
}

async function readVisualComparisons(id) {
  const content = await readOptional(jailed(resolveRunDir(id), 'visual', 'comparisons.json'));
  if (!content) return [];
  const value = JSON.parse(content);
  return Array.isArray(value) ? value : [];
}
```

Include safe reference metadata and visual history in public runs. Do not expose `file`, `buffer`, `runDir`, or absolute paths.

- [ ] **Step 4: Add routes**

Extend the job artifact matcher/resources with:

```text
GET /api/jobs/:id/references/:name
GET /api/jobs/:id/visual
```

Use the stored MIME for reference responses and JSON for visual comparisons. Keep path jail and `nosniff` headers.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test test/console.test.js`

Expected: all console tests pass.

Commit:

```bash
git add src/console/runStore.js src/console/server.js test/console.test.js
git commit -m "feat: expose visual delivery evidence"
```

### Task 10: Chinese Product Lab document structure and copy module

**Files:**
- Create: `src/console/public/copy.js`
- Modify: `src/console/public/index.html`
- Modify: `src/console/public/app.js`
- Modify: `src/console/server.js`
- Modify: `test/console.test.js`
- Modify: `test/console-e2e.test.js`

- [ ] **Step 1: Write RED static UI contracts**

Update the console HTML test to require `lang="zh-CN"`, “你想做什么产品？”, “参考截图”, “开始生成”, “运行设置”, “理解需求”, “视觉校验”, “交付证据”, and the IDs `history-drawer`, `reference-input`, `reference-list`, `settings-drawer`, `flow-workspace`, `visual-comparisons`.

- [ ] **Step 2: Run RED**

Run: `node --test test/console.test.js`

Expected: FAIL against the English industrial console.

- [ ] **Step 3: Create Chinese copy module**

Create `copy.js` exporting exact mappings:

```js
export const STATUS_COPY = { queued: '排队中', planning: '理解需求', building: '生成产品', verifying: '构建验证', visual: '视觉校验', repairing: '自动修复', success: '交付完成', planned: '规划完成', failed: '运行失败' };
export const ERROR_COPY = {
  INPUT_REQUIRED: '请填写需求描述或上传至少一张参考图。',
  REFERENCE_TYPE_UNSUPPORTED: '仅支持 PNG、JPEG 和 WebP 图片。',
  REFERENCE_TOO_LARGE: '单张参考图不能超过 6 MiB。',
  REFERENCE_TOTAL_EXCEEDED: '参考图总大小不能超过 18 MiB。',
  REFERENCE_COUNT_EXCEEDED: '最多上传 4 张参考图。',
  BODY_TOO_LARGE: '提交内容过大，请减少参考图数量或尺寸。',
  VISION_UNSUPPORTED: '当前模型或接口不支持图片理解，请更换支持视觉输入的模型。',
  API_KEY_REQUIRED: '请先在运行设置中填写本次会话使用的 API Key。',
  JOB_ACTIVE: '已有任务正在运行，请等待它完成。',
  INTERNAL_ERROR: '本地工作台暂时无法完成请求，请查看事件记录。',
};
export const EVENT_COPY = { 'plan:start': '正在理解需求与参考图', 'plan:done': '产品规格已经生成', 'build:start': '正在生成产品文件', 'build:done': '产品文件生成完成', 'visual:compare': '正在比较视觉一致性', 'fix:start': '正在根据失败证据修复', 'fix:applied': '修复文件已经应用', review: '机械验收完成', 'report:written': '交付报告已经生成', fatal: '运行发生错误' };
```

- [ ] **Step 4: Replace `index.html` with Focus → Flow markup**

Use one shell with:

```html
<body data-view="focus">
  <div class="app-shell">
    <aside id="history-drawer" class="history-drawer" aria-label="生成历史">
      <button id="history-toggle" type="button" aria-expanded="false" aria-controls="history-panel">展开历史</button>
      <div id="history-panel"><strong>Vibe-one</strong><button id="new-run" type="button">新建任务</button><nav id="run-history" aria-label="历史任务"></nav><span id="connection-label">正在连接</span></div>
    </aside>
    <main class="product-lab">
      <header class="app-header"><div><span>Vibe-one</span><strong>产品实验室</strong></div><div><span id="model-readout">尚未配置模型</span><span id="active-status">就绪</span><button id="settings-trigger" type="button">运行设置</button></div></header>
      <section id="focus-workspace" class="focus-workspace">
        <h1>你想做什么产品？</h1>
        <p>写下核心需求，也可以上传产品截图作为视觉参考。</p>
        <form id="run-form" novalidate><label for="title">任务名称</label><input id="title" maxlength="80"><label for="brief">需求描述</label><textarea id="brief" maxlength="100000"></textarea><div id="reference-dropzone"><button id="reference-trigger" type="button" aria-controls="reference-input"><strong>添加参考截图</strong><span>PNG、JPEG 或 WebP，最多 4 张</span></button></div><input id="reference-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><ol id="reference-list" aria-label="参考截图"></ol><p id="form-message" role="alert"></p><button id="launch-run" type="submit">开始生成</button></form>
      </section>
      <section id="flow-workspace" class="flow-workspace" hidden>
        <header><div><span>当前任务</span><h1 id="run-title">未命名产品</h1></div><dl><div><dt>开始时间</dt><dd id="run-started">--</dd></div><div><dt>修复轮次</dt><dd id="run-repairs">0</dd></div></dl></header>
        <ol id="stage-track" aria-label="生成阶段"><li data-stage="planning">理解需求</li><li data-stage="building">生成产品</li><li data-stage="verifying">构建验证</li><li data-stage="visual">视觉校验</li><li data-stage="repairing">自动修复</li><li data-stage="success">交付完成</li></ol>
        <div class="flow-grid"><section class="activity-panel"><h2>运行动态</h2><ol id="event-log" aria-live="polite"></ol></section><section class="evidence-panel"><header><h2 id="evidence-title">交付证据</h2><button id="refresh-evidence" type="button">刷新</button></header><div class="evidence-tabs" role="tablist"><button role="tab" data-tab="preview" aria-selected="true">实时预览</button><button role="tab" data-tab="references">参考图</button><button role="tab" data-tab="screenshots">结果截图</button><button role="tab" data-tab="visual">视觉比较</button><button role="tab" data-tab="report">交付报告</button><button role="tab" data-tab="repairs">修复记录</button></div><div data-panel="preview"><button id="launch-preview" type="button">启动预览</button><iframe id="preview-frame" title="生成产品预览"></iframe></div><div id="reference-evidence" data-panel="references" hidden></div><div id="screenshots-grid" data-panel="screenshots" hidden></div><div id="visual-comparisons" data-panel="visual" hidden></div><pre id="report-content" data-panel="report" hidden></pre><ol id="repair-list" data-panel="repairs" hidden></ol></section></div>
      </section>
    </main>
    <dialog id="settings-drawer"><form method="dialog"><h2>运行设置</h2><fieldset><legend>执行方式</legend><label><input type="radio" name="mode" value="run" checked>完整生成</label><label><input type="radio" name="mode" value="plan">仅生成规划</label></fieldset><label for="base-url">API endpoint</label><input id="base-url" type="url"><label for="model">模型</label><input id="model"><label for="api-key">会话 API Key</label><input id="api-key" type="password" autocomplete="off"><button id="clear-key" type="button">清除 Key</button><button value="close">完成</button></form></dialog>
  </div>
  <dialog id="image-dialog"><img id="dialog-image" alt="证据截图"><p id="dialog-caption"></p><form method="dialog"><button>关闭</button></form></dialog>
  <div id="toast" role="status" aria-live="polite" hidden></div>
  <script type="module" src="/app.js"></script>
</body>
```

Preserve all existing functional IDs needed by app.js or update app.js in Task 12 in the same commit boundary. Use inline stroke SVGs only; no emoji icons.

- [ ] **Step 5: Preserve a working brief-only flow on the new DOM**

Convert `app.js` to ESM, import `STATUS_COPY`, `ERROR_COPY`, and `EVENT_COPY`, and replace the element map so every selector exists in the new document. Add the initial transition function in this task:

```js
function setWorkspaceView(view) {
  document.body.dataset.view = view;
  elements.focusWorkspace.hidden = view !== 'focus';
  elements.flowWorkspace.hidden = view !== 'flow';
}
```

For this commit, keep the existing JSON request shape (`title`, `brief`, `mode`, `baseUrl`, `model`) and require a non-empty brief. “新建任务” calls `setWorkspaceView('focus')`; starting/selecting a job calls `setWorkspaceView('flow')`. Replace visible English status/event/error strings through `copy.js`, while raw event codes remain secondary text.

- [ ] **Step 6: Serve modules and run GREEN**

Add `/copy.js` to `STATIC_FILES`, change the script to `<script type="module" src="/app.js"></script>`, and run:

`node --test test/console.test.js`

Expected: all static/HTTP tests pass.

Update the existing browser smoke test to use the Chinese labels, then run:

`npm run test:console:e2e`

Expected: the brief-only flow starts, switches from focus to flow, streams events, and opens existing evidence without browser errors.

Commit:

```bash
git add src/console/public/copy.js src/console/public/index.html src/console/public/app.js src/console/server.js test/console.test.js test/console-e2e.test.js
git commit -m "feat: introduce the Chinese Product Lab shell"
```

### Task 11: Browser reference-input controller

**Files:**
- Create: `src/console/public/reference-input.js`
- Modify: `src/console/public/app.js`
- Modify: `src/console/server.js`
- Modify: `test/console-e2e.test.js`

- [ ] **Step 1: Write RED browser upload flow**

In console E2E, use `page.setInputFiles('#reference-input', { name: 'home.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })`; assert the thumbnail row displays `home.png`, the brief can be empty, and the intercepted/stub job has one `config.references` entry.

- [ ] **Step 2: Run RED**

Run: `npm run test:console:e2e`

Expected: FAIL because the controller/module is missing.

- [ ] **Step 3: Implement the controller**

Create `reference-input.js` exporting `createReferenceInputController` with state kept as browser `File` objects and this interface:

```js
export function createReferenceInputController({ input, trigger, dropzone, list, onChange, showError }) {
  const accepted = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const files = [];
  async function add(nextFiles) {
    const incoming = [...nextFiles];
    if (files.length + incoming.length > 4) { showError('最多上传 4 张参考图。'); return; }
    for (const file of incoming) {
      if (!accepted.has(file.type)) { showError('仅支持 PNG、JPEG 和 WebP 图片。'); continue; }
      if (file.size > 6 * 1024 * 1024) { showError(`${file.name} 超过 6 MiB。`); continue; }
      const dimensions = await readDimensions(file);
      files.push({ file, ...dimensions, objectUrl: URL.createObjectURL(file) });
    }
    render();
    onChange(files.length);
  }
  function remove(index) { const [removed] = files.splice(index, 1); if (removed) URL.revokeObjectURL(removed.objectUrl); render(); onChange(files.length); }
  function move(index, delta) { const target = index + delta; if (target < 0 || target >= files.length) return; [files[index], files[target]] = [files[target], files[index]]; render(); }
  async function payload() { return Promise.all(files.map(async ({ file, width, height }) => ({ name: file.name, type: file.type, width, height, base64: await fileBase64(file) }))); }
  function clear() { for (const item of files) URL.revokeObjectURL(item.objectUrl); files.splice(0); render(); onChange(0); }
  function render() {
    list.replaceChildren();
    files.forEach((item, index) => {
      const row = document.createElement('li');
      const image = document.createElement('img'); image.src = item.objectUrl; image.alt = `${item.file.name} 预览`;
      const copy = document.createElement('span'); copy.textContent = `${item.file.name} · ${item.width}×${item.height} · ${(item.file.size / 1024).toFixed(1)} KiB`;
      const up = button('上移', () => move(index, -1)); up.disabled = index === 0;
      const down = button('下移', () => move(index, 1)); down.disabled = index === files.length - 1;
      const del = button('移除', () => remove(index));
      row.append(image, copy, up, down, del); list.append(row);
    });
  }
  trigger.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => { await add(input.files); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.dataset.dragging = 'true'; });
  for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, (event) => { event.preventDefault(); delete dropzone.dataset.dragging; });
  dropzone.addEventListener('drop', (event) => add(event.dataTransfer.files));
  dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
  return { add, remove, move, payload, clear, count: () => files.length };
}

function button(label, onClick) { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; value.addEventListener('click', onClick); return value; }
function readDimensions(file) { return new Promise((resolve, reject) => { const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { const result = { width: image.naturalWidth, height: image.naturalHeight }; URL.revokeObjectURL(url); resolve(result); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`无法读取图片：${file.name}`)); }; image.src = url; }); }
function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
```

Render each row with thumbnail object URL, safe `textContent`, dimensions, size, move-up/down buttons, and remove button. Revoke object URLs on remove/clear.

- [ ] **Step 4: Wire submission**

Make `app.js` an ESM module importing `copy.js` and `reference-input.js`. Submit:

```js
body: JSON.stringify({
  title: elements.title.value,
  brief: elements.brief.value,
  references: await referenceInput.payload(),
  mode: selectedMode(),
  baseUrl: elements.baseUrl.value,
  model: elements.model.value,
})
```

Enable launch when `(brief.trim() || referenceInput.count()) && hasKey && !activeJob`.

- [ ] **Step 5: Serve module, run GREEN, commit**

Add `/reference-input.js` to `STATIC_FILES`.

Run: `npm run test:console:e2e`

Expected: upload flow passes and no secret/base64 appears in page text.

Commit:

```bash
git add src/console/public/reference-input.js src/console/public/app.js src/console/server.js test/console-e2e.test.js
git commit -m "feat: submit reference screenshots from the console"
```

### Task 12: Visual evidence rendering and history replay

**Files:**
- Modify: `src/console/public/app.js`
- Modify: `test/console-e2e.test.js`

- [ ] **Step 1: Write RED evidence assertions**

Assert that selecting a completed visual run renders its reference image, generated comparison image, score, structure/color sub-scores, threshold, round number, and explicit pass/fail text. Reload the page, select the persisted run again, and assert the same evidence is reconstructed from run storage rather than live job memory.

- [ ] **Step 2: Run RED**

Run: `npm run test:console:e2e`

Expected: FAIL because reference/visual tabs are not populated.

- [ ] **Step 3: Load structured reference and visual evidence**

Add these loaders and call them from job selection/tab changes:

```js
async function loadReferenceEvidence(job) {
  renderReferenceEvidence(job.references || [], (name) => `/api/jobs/${encodeURIComponent(job.id)}/references/${encodeURIComponent(name)}`);
}

async function loadVisualEvidence(job) {
  const history = await api(`/api/jobs/${encodeURIComponent(job.id)}/visual`);
  renderVisualComparisons(history, job.id);
}
```

- [ ] **Step 4: Render comparison evidence safely**

Create comparison cards using only DOM methods and `textContent`. Reference URL: `/api/jobs/:id/references/:name`; generated URL: `/api/jobs/:id/screenshots/:actualImage`. Render the newest round first while retaining every prior round so the repair improvement is auditable.

Each card must include `aria-label="<page> 视觉一致性 <score>"` and a non-color status label.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:console:e2e`

Expected: Focus → Flow and evidence tests pass.

Commit:

```bash
git add src/console/public/app.js test/console-e2e.test.js
git commit -m "feat: render the Product Lab generation flow"
```

### Task 13: Product Lab visual system and responsive polish

**Files:**
- Modify: `src/console/public/app.css`
- Modify: `test/console-e2e.test.js`

- [ ] **Step 1: Add RED visual/accessibility contracts**

At 1440×900 assert the history rail is collapsed by default, focus canvas is centered, primary input and screenshot dropzone are above the fold, and no horizontal overflow exists. At 390×844 assert no horizontal overflow, settings/history dialogs open, input and launch controls remain reachable. Emulate reduced motion and assert computed animation duration is `0s` or `0.01ms` for the workspace transition.

- [ ] **Step 2: Run RED**

Run: `npm run test:console:e2e`

Expected: FAIL against the old stylesheet.

- [ ] **Step 3: Replace visual tokens and layout**

Start `app.css` with:

```css
:root {
  color-scheme: light;
  --canvas: #f3f6fb;
  --surface: #ffffff;
  --surface-soft: #f8faff;
  --ink: #172033;
  --muted: #667085;
  --line: #dce3ef;
  --primary: #2457f5;
  --primary-strong: #1745d8;
  --primary-soft: #e8edff;
  --accent: #ffb547;
  --success: #168463;
  --danger: #c93f4b;
  --shadow-sm: 0 8px 24px rgba(39, 57, 92, .08);
  --shadow-lg: 0 24px 64px rgba(39, 57, 92, .16);
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 24px;
  --ease: cubic-bezier(.22, 1, .36, 1);
  font-family: "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
}
```

Implement these exact layout rules:

- `.app-shell`: grid columns `72px minmax(0,1fr)`; expanded history uses `280px`.
- `.focus-workspace`: max-width `1040px`, centered, min-height `calc(100vh - 72px)`, two-column input/reference grid above 1100px and one column below.
- `.flow-workspace`: grid columns `minmax(360px,.42fr) minmax(520px,.58fr)` with a 20px gap.
- `.history-drawer`: fixed-height viewport, collapsed icon rail, expanded overlay on widths below 1100px.
- `.preview-stage`: reserved stable height with `aspect-ratio` and no layout shift.
- Buttons/inputs: minimum 44px hit area, 3px visible focus ring, disabled/loading styles without layout movement.
- Comparison cards: side-by-side reference/output images on desktop, stacked below 760px.
- No `backdrop-filter`, no emoji, no purple gradients, no animation of width/height.

- [ ] **Step 4: Add motion and reduced-motion rules**

Use opacity/transform only for Focus → Flow, drawer, toast, and evidence-tab transitions, 180–260ms. Add:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
```

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:console:e2e`

Expected: desktop/narrow/reduced-motion checks pass.

Run: `node --check src/console/public/app.js`

Expected: no syntax errors.

Commit:

```bash
git add src/console/public/app.css test/console-e2e.test.js
git commit -m "feat: polish the Product Lab workspace"
```

---

## Phase 4 — Documentation, real verification, and handoff

### Task 14: Documentation and committed UI evidence

**Files:**
- Modify: `README.md`
- Modify: `FRAMEWORK.md`
- Modify: `docs/architecture.md`
- Modify: `docs/HANDOFF.md`
- Modify: `history.md`
- Replace: `docs/screenshots/console-desktop.png`
- Replace: `docs/screenshots/console-mobile.png`

- [ ] **Step 1: Update truth-source documentation**

Document:

- Text-only, screenshot-only, and combined inputs.
- PNG/JPEG/WebP and size/count limits.
- Multimodal planner → structured visual spec → mechanical SSIM/histogram gate → visual fixer data flow.
- The 0.62 default is coarse consistency, not pixel-perfect cloning.
- Session-only credentials and secret/base64/path non-persistence guarantees.
- Product Lab commands and evidence locations.

Remove statements that screenshot input/visual comparison remain deferred.

- [ ] **Step 2: Generate deterministic console screenshots**

Run: `npm run test:console:e2e`

Copy the generated 1440×900 and 390×844 Product Lab screenshots to `docs/screenshots/console-desktop.png` and `docs/screenshots/console-mobile.png`. Inspect both images for clipped Chinese text, overlapping controls, broken thumbnails, empty iframe regions, and low-contrast states.

- [ ] **Step 3: Run the full offline verification**

Run: `npm test`

Expected: all offline tests pass; only documented opt-in E2E tests are skipped.

Run: `npm run test:console:e2e`

Expected: every console Playwright test passes at desktop, narrow, and reduced-motion settings.

Run: `$env:VIBE_ONE_E2E='1'; npm test`

Expected: normal, repair, visual-pass, and visual-repair full pipelines pass.

- [ ] **Step 4: Run syntax, security, and repository checks**

Run:

```powershell
node --check src/console/public/app.js
node --check src/console/public/reference-input.js
node --check src/core/referenceImages.js
node --check src/runner/visualCompare.js
git diff --check
rg -n "sk-[A-Za-z0-9_-]{16,}|data:image/.+;base64,[A-Za-z0-9+/]{100,}|https://7x\.hk" README.md FRAMEWORK.md docs src test history.md
```

Expected: syntax checks succeed, `git diff --check` is clean, and secret/base64/private-endpoint scan returns no matches outside intentionally tiny test fixtures (test fixtures must use one-pixel images and no real endpoint/key).

- [ ] **Step 5: Record completion and commit**

Append a timestamped `history.md` entry with implemented scope, exact verification counts, real/stub visual demo results, commit, and remaining boundaries.

Commit:

```bash
git add README.md FRAMEWORK.md docs/architecture.md docs/HANDOFF.md history.md docs/screenshots/console-desktop.png docs/screenshots/console-mobile.png
git commit -m "docs: present the Product Lab visual workflow"
```

### Task 15: Final review, push, and durable memory

**Files:**
- Review all changed files
- Update: `D:\Codex\codexRules.md` only with the durable milestone and verified baseline

- [ ] **Step 1: Review the complete diff against the approved spec**

Confirm every completion criterion in `docs/superpowers/specs/2026-07-10-product-lab-visual-input-design.md` has a test or visible evidence. Confirm there is no silent visual fallback, no model self-grading, no widened generated-app dependency whitelist, and no secret/base64/path leak.

- [ ] **Step 2: Verify clean synchronized Git state**

Run:

```powershell
git status -sb
git log -8 --oneline
git diff origin/main --stat
```

Expected before push: only intended committed work, local branch ahead of `origin/main`, no unstaged files.

- [ ] **Step 3: Push**

Run: `git push origin main`

Expected: remote advances to the final Product Lab commit.

- [ ] **Step 4: Update durable memory**

Record only stable facts in `D:\Codex\codexRules.md`: Product Lab is all Chinese, accepts text/screenshots, uses deterministic local visual checks and bounded visual repair, exact verification baseline, canonical commands, and remaining product boundary. Do not record API keys, private endpoints, base64, temporary run IDs, or transient debug details.

- [ ] **Step 5: Final status check**

Run: `git status -sb`

Expected: `## main...origin/main` with a clean worktree.
