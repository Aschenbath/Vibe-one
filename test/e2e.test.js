// End-to-end integration test WITHOUT a live model.
// A stub provider returns a fixed spec + a real runnable React app, and the full
// pipeline (plan -> build -> npm install -> vite build -> preview -> Playwright
// -> reviewer -> reporter) runs for real against them.
//
// Purpose: prove the whole pipeline is wired correctly and the reviewer/scenario
// machinery actually passes on a known-good app, WITHOUT spending any API quota.
// The ONLY remaining unknown after this passes is the real model's JSON shape.
//
// Opt-in (needs npm registry + installed Playwright chromium), so default
// `npm test` stays offline and instant:
//   VIBE_ONE_E2E=1 node --test test/e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipeline } from '../src/core/pipeline.js';

const ENABLED = process.env.VIBE_ONE_E2E === '1';

// A minimal but genuinely runnable React + Vite app that satisfies the spec below.
const APP_FILES = [
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Expenses</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  },
  {
    path: 'src/main.jsx',
    content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);
`,
  },
  {
    path: 'src/App.jsx',
    content: `import React, { useState } from 'react';

const SEED = [
  { id: 1, note: 'Coffee', amount: 18 },
  { id: 2, note: 'Bus', amount: 4 },
];

export default function App() {
  const [items, setItems] = useState(SEED);
  const total = items.reduce((s, i) => s + i.amount, 0);
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16 }}>
      <h1>Expenses</h1>
      <p>Total: ¥{total}</p>
      <button onClick={() => setItems((prev) => [...prev, { id: Date.now(), note: 'New item', amount: 10 }])}>
        Add
      </button>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.note} — ¥{i.amount}</li>
        ))}
      </ul>
    </main>
  );
}
`,
  },
];

const SPEC = {
  summary: 'Minimal expense tracker for pipeline integration testing.',
  pages: [{ name: 'Home', route: '/', purpose: 'list + total', mustContain: ['Expenses', 'Total'] }],
  components: [{ name: 'App', usedBy: 'Home' }],
  dataModel: [{ entity: 'Expense', fields: ['id', 'note', 'amount'] }],
  interactions: ['click Add appends a new row'],
  acceptance: ['Total reflects seeded expenses', 'Add appends a visible new row'],
  scenarios: [
    { name: 'add appends new row', route: '/', steps: [{ action: 'click', target: 'Add' }], expectText: 'New item' },
  ],
};

// Stub provider: first chatJson call -> spec, second -> files. Deterministic, no network.
function createStubProvider() {
  let call = 0;
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  return {
    async chat() {
      throw new Error('stub chat() should not be called by the pipeline');
    },
    async chatJson() {
      call += 1;
      if (call === 1) return { json: SPEC, usage, model: 'stub' };
      return { json: { files: APP_FILES }, usage, model: 'stub' };
    },
  };
}

test('full pipeline succeeds end-to-end with a stub model (no API)', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-e2e-'));
  const targetDir = path.join(tmpRoot, 'target');
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), '# Expenses\nList expenses with a total and an Add button.\n');

  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 0, // known-good app: must pass on round 0
    model: 'stub',
    baseUrl: 'http://stub.local/v1',
    temperature: 0.2,
    brief: '# Expenses\nList expenses with a total and an Add button.\n',
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  const result = await runPipeline({ targetDir, config, provider: createStubProvider() });

  assert.equal(result.status, 'success', 'pipeline should report success on a known-good app');

  // Report exists and records a passing run.
  const report = await fs.readFile(path.join(result.runDir, 'DELIVERY_REPORT.md'), 'utf8');
  assert.match(report, /Status: \*\*success\*\*/);
  assert.match(report, /add appends new row|add appends new row/i);

  // Screenshots were captured for the planned page + the scenario.
  const shots = await fs.readdir(path.join(result.runDir, 'screenshots'));
  assert.ok(shots.some((f) => f.endsWith('.png')), 'expected at least one screenshot');

  // The fixed scaffold was written by the pipeline, not the model.
  const pkg = JSON.parse(await fs.readFile(path.join(result.runDir, 'app', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'vite build');

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('e2e test is opt-in', () => {
  // Always-on marker so `npm test` shows the e2e suite exists but is gated.
  assert.ok(true);
  if (!ENABLED) console.log('  (e2e skipped; set VIBE_ONE_E2E=1 to run the full no-API integration test)');
});
