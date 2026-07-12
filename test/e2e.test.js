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
import { loadConfig } from '../src/core/config.js';
import { runPipeline } from '../src/core/pipeline.js';

const ENABLED = process.env.VIBE_ONE_E2E === '1';

const E2E_PRODUCT_DESIGN = {
  productType: 'Operational workflow web application',
  targetUsers: ['Operations manager', 'Quality specialist'],
  tone: 'Dense operational workspace focused on actionable records',
  density: 'compact',
  navigation: 'Persistent primary navigation with page-level task context',
  contentStrategy: 'Prioritize current status, actionable records, and verified outcomes',
  componentLanguage: ['Metric cards', 'Structured lists', 'Clear action controls'],
  responsiveRules: ['Stack content on narrow screens', 'Keep actions at least 44 pixels'],
  tokens: {
    colors: {
      canvas: '#F4F6F8',
      surface: '#FFFFFF',
      text: '#17202A',
      primary: '#2457D6',
      success: '#16825D',
      danger: '#C53A3A',
    },
    typography: {
      display: '700 32px/1.2 Arial',
      heading: '700 24px/1.3 Arial',
      body: '400 16px/1.5 Arial',
      caption: '500 14px/1.4 Arial',
    },
    spacing: ['4px', '8px', '12px', '16px', '24px'],
    radii: ['4px', '8px', '12px'],
  },
  requiredStates: [
    { name: 'loading', trigger: 'Initial data is being prepared' },
    { name: 'empty', trigger: 'No records match the active filters' },
  ],
};

const VISUAL_CSS = `*{box-sizing:border-box}
html,body,#root{margin:0;min-height:100%;background:#fff;font-family:Arial,sans-serif;color:#111}
.primary-nav{height:48px;padding:14px 24px;background:#fff;border-bottom:1px solid #dce3ef}
.screen{min-height:844px;background:#fff}
.hero{height:132px;background:#2457f5;color:#fff;padding:32px 24px}
.hero h1{margin:0;font-size:28px}
.card{margin:24px;padding:24px;border-radius:20px;background:#ffb547;font-size:22px;font-weight:700}
.list{margin:24px;padding:20px;border:1px solid #dce3ef;border-radius:16px}
.row{height:52px;border-bottom:1px solid #dce3ef;display:flex;align-items:center;justify-content:space-between}
.row:last-child{border-bottom:0}
.state-evidence{margin:8px 24px;color:#17202a}`;

const WRONG_VISUAL_CSS = `*{box-sizing:border-box}
html,body,#root{margin:0;min-height:100%;background:#050505;font-family:Arial,sans-serif;color:#ff3344}
.primary-nav{height:48px;padding:14px 24px;background:#050505;border-bottom:1px solid #ff3344}
.screen{min-height:844px;background:#050505}
.hero{height:420px;background:#050505;color:#ff3344;padding:150px 12px 12px;text-align:center}
.hero h1{margin:0;font-size:42px}
.card{margin:0;padding:48px 12px;border-radius:0;background:#d40020;color:#050505;font-size:30px;font-weight:700;text-align:center}
.list{margin:0;padding:8px;border:18px solid #050505;border-radius:0;background:#d40020;color:#fff}
.row{height:30px;border-bottom:4px solid #050505;display:flex;align-items:center;justify-content:space-between}
.state-evidence{margin:8px 12px}`;

const VISUAL_MARKUP = `<nav class="primary-nav" aria-label="Primary">Expense workspace</nav>
<main class="screen">
  <section class="hero"><h1>自由职业支出</h1></section>
  <section class="card">本月支出 ¥4,820</section>
  <section class="list">
    <div class="row"><span>办公软件</span><strong>¥1,200</strong></div>
    <div class="row"><span>交通出行</span><strong>¥320</strong></div>
    <div class="row"><span>设备采购</span><strong>¥3,300</strong></div>
  </section>
  <section class="state-evidence" data-ui-state="loading">Loading evidence ready</section>
  <section class="state-evidence" data-ui-state="empty">Empty evidence ready</section>
</main>`;

const VISUAL_APP = `import React from 'react';
import './styles.css';

export default function App() {
  return (
    <>
      <nav className="primary-nav" aria-label="Primary">Expense workspace</nav>
      <main className="screen">
      <section className="hero"><h1>自由职业支出</h1></section>
      <section className="card">本月支出 ¥4,820</section>
      <section className="list">
        <div className="row"><span>办公软件</span><strong>¥1,200</strong></div>
        <div className="row"><span>交通出行</span><strong>¥320</strong></div>
        <div className="row"><span>设备采购</span><strong>¥3,300</strong></div>
      </section>
        <section className="state-evidence" data-ui-state="loading">Loading evidence ready</section>
        <section className="state-evidence" data-ui-state="empty">Empty evidence ready</section>
      </main>
    </>
  );
}
`;

const VISUAL_SPEC = {
  summary: '根据参考图生成的自由职业支出看板。',
  visualDesign: {
    layout: '顶部品牌区、月度支出卡片、三行支出列表',
    palette: ['#2457f5', '#ffb547', '#ffffff'],
    typography: 'Arial clean sans-serif',
    spacing: '24px content rhythm',
    components: ['Hero', 'SummaryCard', 'ExpenseList'],
    responsive: '390px mobile reference with fluid desktop width',
  },
  productDesign: E2E_PRODUCT_DESIGN,
  pages: [{
    name: 'Home',
    route: '/',
    purpose: '展示月度支出概览',
    mustContain: ['自由职业支出', '本月支出', '办公软件'],
    referenceImage: 'home.png',
  }],
  components: [{ name: 'ExpenseDashboard', usedBy: 'Home' }],
  dataModel: [{ entity: 'Expense', fields: ['label', 'amount'] }],
  interactions: [],
  acceptance: ['页面内容与参考图保持粗粒度视觉一致'],
  scenarios: [],
};

function visualAppFiles(css) {
  return [
    {
      path: 'index.html',
      content: '<!doctype html><html><head><meta charset="UTF-8" /><title>支出看板</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    },
    {
      path: 'src/main.jsx',
      content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    },
    { path: 'src/App.jsx', content: VISUAL_APP },
    { path: 'src/styles.css', content: css },
  ];
}

function fileBlocks(files) {
  return files.map((file) => `=== FILE: ${file.path}\n${file.content}\n=== END ===`).join('\n');
}

async function writeVisualReference(targetDir) {
  const dir = path.join(targetDir, 'input', 'references');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'home.png');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><style>${VISUAL_CSS}</style><div id="root">${VISUAL_MARKUP}</div>`);
    await page.screenshot({ path: file, fullPage: false });
  } finally {
    await browser.close();
  }
  const bytes = (await fs.stat(file)).size;
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify([{
      name: 'home.png',
      type: 'image/png',
      width: 390,
      height: 844,
      bytes,
    }], null, 2),
  );
  return file;
}

function createVisualProvider({ repair = false } = {}) {
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  let chatCalls = 0;
  return {
    async chatJson({ user }) {
      assert.ok(Array.isArray(user), 'planner should receive multimodal content');
      assert.equal(user.filter((part) => part.type === 'image_url').length, 1);
      return { json: VISUAL_SPEC, usage, model: 'stub-visual' };
    },
    async chat({ system, user }) {
      if (/single-pass UI polisher/i.test(system)) {
        return {
          content: fileBlocks([{
            path: 'src/styles.css',
            content: `${VISUAL_CSS}\n/* polish verified */`,
          }]),
          usage,
          model: 'stub-visual',
        };
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          content: fileBlocks(visualAppFiles(repair ? WRONG_VISUAL_CSS : VISUAL_CSS)),
          usage,
          model: 'stub-visual',
        };
      }
      assert.equal(repair, true, 'only the repair provider should receive a fixer call');
      assert.ok(Array.isArray(user), 'visual fixer should receive multimodal content');
      assert.equal(user.filter((part) => part.type === 'image_url').length, 2);
      return {
        content: `=== DIAGNOSIS ===
Restored the blue and amber reference palette and its original spacing.
=== FILE: src/styles.css
${VISUAL_CSS}
=== END ===`,
        usage,
        model: 'stub-visual',
      };
    },
  };
}

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
    <>
      <nav aria-label="Primary" style={{ padding: 16, borderBottom: '1px solid #d8dde5' }}>Expense workspace</nav>
      <main style={{ fontFamily: 'sans-serif', padding: 16 }}>
      <h1>Expenses</h1>
      <p>Total: ¥{total}</p>
      <button data-ui-native-styled style={{ minWidth: 44, height: 44, borderRadius: 6 }} onClick={() => setItems((prev) => [...prev, { id: Date.now(), note: 'New item', amount: 10 }])}>
        Add
      </button>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.note} — ¥{i.amount}</li>
        ))}
      </ul>
        <section data-ui-state="loading">Loading evidence ready</section>
        <section data-ui-state="empty">Empty evidence ready</section>
      </main>
    </>
  );
}
`,
  },
];

const SPEC = {
  summary: 'Minimal expense tracker for pipeline integration testing.',
  productDesign: E2E_PRODUCT_DESIGN,
  pages: [{ name: 'Home', route: '/', purpose: 'list + total', mustContain: ['Expenses', 'Total'] }],
  components: [{ name: 'App', usedBy: 'Home' }],
  dataModel: [{ entity: 'Expense', fields: ['id', 'note', 'amount'] }],
  interactions: ['click Add appends a new row'],
  acceptance: ['Total reflects seeded expenses', 'Add appends a visible new row'],
  scenarios: [
    { name: 'add appends new row', route: '/', steps: [{ action: 'click', target: 'Add' }], expectText: 'New item' },
  ],
};

// Stub provider: plan() uses chatJson (spec is small structured JSON); build()
// uses chat and expects the delimiter file protocol. Deterministic, no network.
function createStubProvider() {
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  const buildContent = APP_FILES.map((f) => `=== FILE: ${f.path}\n${f.content}=== END ===`).join('\n');
  return {
    async chat({ system }) {
      if (/single-pass UI polisher/i.test(system)) {
        const app = APP_FILES.find((file) => file.path === 'src/App.jsx');
        return {
          content: fileBlocks([{
            ...app,
            content: app.content.replace('<main style=', `<main data-polish-marker='verified' style=`),
          }]),
          usage,
          model: 'stub',
        };
      }
      return { content: buildContent, usage, model: 'stub' };
    },
    async chatJson() {
      return { json: SPEC, usage, model: 'stub' };
    },
  };
}

function createPolishLifecycleProvider({ breakInteraction = false } = {}) {
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  const observed = { buildCalls: 0, polishCalls: 0, polishImages: 0, polishText: '' };
  const draftApp = APP_FILES.find((file) => file.path === 'src/App.jsx').content;
  const polishedApp = breakInteraction
    ? draftApp.replace(`note: 'New item'`, `note: 'Broken item'`)
    : draftApp.replace('<main style=', `<main data-polish-marker='verified' style=`);
  return {
    observed,
    async chatJson() {
      return { json: SPEC, usage, model: 'stub-polish-lifecycle' };
    },
    async chat({ system, user }) {
      if (/single-pass UI polisher/i.test(system)) {
        observed.polishCalls += 1;
        observed.polishImages = user.filter((part) => part.type === 'image_url').length;
        observed.polishText = user.find((part) => part.type === 'text')?.text ?? '';
        return {
          content: `=== FILE: src/App.jsx\n${polishedApp}\n=== END ===`,
          usage,
          model: 'stub-polish-lifecycle',
        };
      }
      observed.buildCalls += 1;
      return { content: fileBlocks(APP_FILES), usage, model: 'stub-polish-lifecycle' };
    },
  };
}

const NOTES_SPEC = {
  summary: 'Minimal notes app used to prove a failed build can be repaired.',
  productDesign: E2E_PRODUCT_DESIGN,
  pages: [{ name: 'Notes', route: '/', purpose: 'list notes', mustContain: ['Notes', 'Project brief'] }],
  components: [{ name: 'App', usedBy: 'Notes' }],
  dataModel: [{ entity: 'Note', fields: ['id', 'title'] }],
  interactions: ['click Add note appends a note'],
  acceptance: ['Seeded note is visible', 'Add creates a visible note'],
  scenarios: [
    { name: 'add creates a visible note', route: '/', steps: [{ action: 'click', target: 'Add note' }], expectText: 'New note' },
  ],
};

const NOTES_SHARED_FILES = [
  {
    path: 'index.html',
    content: `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Notes</title></head>
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
];

const BROKEN_NOTES_APP = `import React, { useState } from 'react';

export default function App() {
  const [notes, setNotes] = useState(['Project brief']);
  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16 }}>
      <nav aria-label="Primary">Notes workspace</nav>
      <h1>Notes</h1>
      <button data-ui-native-styled style={{ minWidth: 44, height: 44, borderRadius: 6 }} onClick={() => setNotes((items) => [...items, 'New note'])}>Add note</button>
      <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
      <section data-ui-state="loading">Loading evidence ready</section>
      <section data-ui-state="empty">Empty evidence ready</section>
    </main>
  );
`;

const FIXED_NOTES_APP = `${BROKEN_NOTES_APP}}\n`;

function createRepairingNotesProvider() {
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  let chatCalls = 0;
  return {
    async chatJson() {
      return { json: NOTES_SPEC, usage, model: 'stub-repair' };
    },
    async chat({ system }) {
      if (/single-pass UI polisher/i.test(system)) {
        return {
          content: `=== FILE: src/App.jsx\n${FIXED_NOTES_APP}// polish verified\n=== END ===`,
          usage,
          model: 'stub-repair',
        };
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        const files = [...NOTES_SHARED_FILES, { path: 'src/App.jsx', content: BROKEN_NOTES_APP }];
        const content = files.map((file) => `=== FILE: ${file.path}\n${file.content}=== END ===`).join('\n');
        return { content, usage, model: 'stub-repair' };
      }
      return {
        content: `=== DIAGNOSIS ===
Restored the missing component closure and kept the Add note interaction.
=== FILE: src/App.jsx
${FIXED_NOTES_APP}=== END ===`,
        usage,
        model: 'stub-repair',
      };
    },
  };
}

const UI_REPAIR_SPEC = {
  summary: 'UI quality repair fixture with a functional action.',
  productDesign: E2E_PRODUCT_DESIGN,
  pages: [{
    name: 'Overview',
    route: '/',
    purpose: 'Show records and add one',
    mustContain: ['Quality overview', 'Seed record'],
  }],
  components: [{ name: 'Overview', usedBy: 'Overview' }],
  dataModel: [{ entity: 'Record', fields: ['label'] }],
  interactions: ['click Add record appends a record'],
  acceptance: ['Seed record is visible', 'Add record remains functional'],
  scenarios: [{
    name: 'add record remains functional',
    route: '/',
    steps: [{ action: 'click', target: 'Add record' }],
    expectText: 'New record',
  }],
};

const UI_REPAIR_APP = `import React, { useState } from 'react';
import './styles.css';

export default function App() {
  const [records, setRecords] = useState(['Seed record']);
  return (
    <>
      <nav aria-label="Primary">Quality workspace</nav>
      <main>
        <h1>Quality overview</h1>
        <button data-ui-native-styled onClick={() => setRecords((items) => [...items, 'New record'])}>Add record</button>
        <ul>{records.map((record) => <li key={record}>{record}</li>)}</ul>
        <section data-ui-state="loading">Loading evidence ready</section>
        <section data-ui-state="empty">Empty evidence ready</section>
      </main>
    </>
  );
}
`;

function uiRepairCss(size) {
  return `*{box-sizing:border-box}
html,body,#root{margin:0;min-height:100%;background:#fff;color:#17202a;font:16px Arial,sans-serif}
nav{height:48px;padding:14px 20px;border-bottom:1px solid #d8dde5}
main{min-height:500px;padding:24px}
button{width:${size}px;height:${size}px;border:1px solid #173f9e;border-radius:6px;background:#2457d6;color:#fff}
section{margin-top:12px}`;
}

function uiRepairFiles(size) {
  return [
    {
      path: 'index.html',
      content: '<!doctype html><html><head><meta charset=UTF-8></head><body><div id=root></div><script type=module src=/src/main.jsx></script></body></html>',
    },
    {
      path: 'src/main.jsx',
      content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    },
    { path: 'src/App.jsx', content: UI_REPAIR_APP },
    { path: 'src/styles.css', content: uiRepairCss(size) },
  ];
}

function createUiRepairProvider() {
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  let chatCalls = 0;
  const observed = { promptText: '', imageCount: 0 };
  return {
    observed,
    async chatJson() {
      return { json: UI_REPAIR_SPEC, usage, model: 'stub-ui-repair' };
    },
    async chat({ system, user }) {
      if (/single-pass UI polisher/i.test(system)) {
        return {
          content: fileBlocks([{
            path: 'src/styles.css',
            content: `${uiRepairCss(44)}\n/* polish verified */`,
          }]),
          usage,
          model: 'stub-ui-repair',
        };
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          content: fileBlocks(uiRepairFiles(32)),
          usage,
          model: 'stub-ui-repair',
        };
      }
      observed.promptText = user
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      observed.imageCount = user.filter((part) => part.type === 'image_url').length;
      return {
        content: `=== DIAGNOSIS ===
Raised the Add record control to the required 44 pixel target.
=== FILE: src/styles.css
${uiRepairCss(44)}
=== END ===`,
        usage,
        model: 'stub-ui-repair',
      };
    },
  };
}

test('green draft is polished, fully reverified, and promoted before delivery', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-polish-success-')),
  );
  const targetDir = path.join(tmpRoot, 'target');
  const brief = '# Expenses\nList expenses with a total and an Add button.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  const provider = createPolishLifecycleProvider();
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 0,
    maxPolishRounds: 1,
    model: 'stub-polish-lifecycle',
    baseUrl: 'http://stub.local/v1',
    temperature: 0.2,
    brief,
    references: [],
    visualThreshold: 0.62,
    runsRoot: path.join(tmpRoot, 'runs'),
  };
  try {
    const result = await runPipeline({ targetDir, config, provider });
    assert.equal(result.status, 'success');
    assert.equal(result.errorCode, undefined);
    assert.equal(provider.observed.buildCalls, 1);
    assert.equal(provider.observed.polishCalls, 1);
    assert.equal(provider.observed.polishImages, 2);
    assert.match(provider.observed.polishText, /UI audit summary|Structured UI audit summary/i);
    assert.deepEqual(result.polish.changedFiles, ['src/App.jsx']);
    assert.equal(result.polish.status, 'promoted');
    assert.equal(result.polish.draftReview.pass, true);
    assert.equal(result.polish.candidateReview.pass, true);

    const finalApp = await fs.readFile(path.join(result.runDir, 'app', 'src', 'App.jsx'), 'utf8');
    const draftApp = await fs.readFile(
      path.join(result.runDir, 'polish', 'draft-app', 'src', 'App.jsx'),
      'utf8',
    );
    assert.match(finalApp, /data-polish-marker='verified'/);
    assert.doesNotMatch(draftApp, /data-polish-marker/);
    await assert.rejects(
      fs.stat(path.join(result.runDir, 'polish', 'candidate')),
      { code: 'ENOENT' },
    );

    const [draftQuality, polishQuality, polishVisual] = await Promise.all([
      fs.readFile(path.join(result.runDir, 'quality', 'history.json'), 'utf8'),
      fs.readFile(path.join(result.runDir, 'polish', 'quality', 'history.json'), 'utf8'),
      fs.readFile(path.join(result.runDir, 'polish', 'visual', 'comparisons.json'), 'utf8'),
    ]);
    assert.equal(JSON.parse(draftQuality).length, 1);
    assert.equal(JSON.parse(polishQuality).length, 1);
    assert.equal(JSON.parse(polishVisual).length, 1);

    const eventsText = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line));
    const firstReview = events.findIndex((event) => event.type === 'review');
    const polishStart = events.findIndex((event) => event.type === 'polish:start');
    const polishApplied = events.findIndex((event) => event.type === 'polish:applied');
    const secondReview = events.findIndex(
      (event, index) => index > polishApplied && event.type === 'review',
    );
    const reportWritten = events.findIndex((event) => event.type === 'report:written');
    assert.ok(firstReview >= 0 && firstReview < polishStart);
    assert.ok(polishStart < polishApplied && polishApplied < secondReview);
    assert.ok(secondReview < reportWritten);
    assert.equal(events.filter((event) => event.type === 'review').length, 2);
    assert.equal(events.some((event) => event.type === 'polish:failed'), false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('failed polish verification keeps the working draft and returns POLISH_FAILED', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-polish-failed-')),
  );
  const targetDir = path.join(tmpRoot, 'target');
  const brief = '# Expenses\nList expenses with a total and an Add button.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  const provider = createPolishLifecycleProvider({ breakInteraction: true });
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 1,
    maxPolishRounds: 1,
    model: 'stub-polish-failed',
    baseUrl: 'https://private.invalid/v1',
    temperature: 0.2,
    brief,
    references: [],
    visualThreshold: 0.62,
    runsRoot: path.join(tmpRoot, 'runs'),
  };
  try {
    const result = await runPipeline({ targetDir, config, provider });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'POLISH_FAILED');
    assert.equal(provider.observed.buildCalls, 1);
    assert.equal(provider.observed.polishCalls, 1);
    assert.equal(result.polish.status, 'failed');
    assert.deepEqual(result.polish.changedFiles, ['src/App.jsx']);
    assert.equal(result.polish.draftReview.pass, true);
    assert.equal(result.polish.candidateReview.pass, false);

    const original = await fs.readFile(path.join(result.runDir, 'app', 'src', 'App.jsx'), 'utf8');
    const candidate = await fs.readFile(
      path.join(result.runDir, 'polish', 'candidate', 'src', 'App.jsx'),
      'utf8',
    );
    assert.match(original, /note: 'New item'/);
    assert.doesNotMatch(original, /Broken item/);
    assert.match(candidate, /Broken item/);
    await assert.rejects(
      fs.stat(path.join(result.runDir, 'polish', 'draft-app')),
      { code: 'ENOENT' },
    );

    const eventsText = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line));
    const failed = events.filter((event) => event.type === 'polish:failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].code, 'POLISH_FAILED');
    assert.match(failed[0].summary, /candidate verification failed/i);
    assert.doesNotMatch(
      JSON.stringify(failed[0]),
      /private\.invalid|Broken item|expected text|[A-Z]:\\/i,
    );
    assert.doesNotMatch(eventsText, /private\.invalid|Broken item|[A-Z]:\\/i);
    assert.equal(events.filter((event) => event.type === 'fix:start').length, 0);
    assert.equal(events.filter((event) => event.type === 'review').length, 2);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('plan-only pipeline never builds or polishes', { skip: !ENABLED, timeout: 30_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-polish-plan-only-')),
  );
  const targetDir = path.join(tmpRoot, 'target');
  const brief = '# Expenses\nPlan an expense tracker.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  let plannerCalls = 0;
  let chatCalls = 0;
  try {
    const result = await runPipeline({
      targetDir,
      planOnly: true,
      config: {
        stack: 'react-vite',
        viewport: { width: 390, height: 844 },
        maxRepairRounds: 1,
        maxPolishRounds: 1,
        model: 'stub-plan-only',
        baseUrl: 'http://stub.local/v1',
        temperature: 0.2,
        brief,
        references: [],
        runsRoot: path.join(tmpRoot, 'runs'),
      },
      provider: {
        async chatJson() {
          plannerCalls += 1;
          return { json: SPEC, usage: {}, model: 'stub-plan-only' };
        },
        async chat() {
          chatCalls += 1;
          throw new Error('build/polish must not run');
        },
      },
    });
    assert.equal(result.status, 'planned');
    assert.equal(plannerCalls, 1);
    assert.equal(chatCalls, 0);
    const events = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    assert.doesNotMatch(events, /polish:|build:start/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('full pipeline succeeds end-to-end with a stub model (no API)', { skip: !ENABLED, timeout: 300_000 }, async () => {
  // Canonicalize Windows 8.3 temp aliases (for example ASCHEN~1). Vite/Rollup
  // otherwise sees the long and short spellings as different roots.
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-e2e-')));
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

test('repair loop fixes a broken notes app and reaches success', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const provider = createRepairingNotesProvider();
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-repair-e2e-')));
  const targetDir = path.join(tmpRoot, 'notes-mobile');
  const brief = '# Notes\nList notes and let the user add a new note.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);

  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 1,
    model: 'stub-repair',
    baseUrl: 'http://stub.local/v1',
    temperature: 0.2,
    brief,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  const result = await runPipeline({ targetDir, config, provider });

  assert.equal(result.status, 'success', 'pipeline should recover after one repair round');
  const report = await fs.readFile(path.join(result.runDir, 'DELIVERY_REPORT.md'), 'utf8');
  assert.match(report, /Repair rounds used: 1\/1/);
  assert.match(report, /restored the missing component closure/i);
  assert.match(report, /add creates a visible note/i);

  const shots = await fs.readdir(path.join(result.runDir, 'screenshots'));
  assert.ok(shots.some((f) => f.startsWith('scenario-') && f.endsWith('.png')));

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('UI quality failure sends screenshots to the fixer and passes after one repair', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-ui-quality-repair-')),
  );
  const targetDir = path.join(tmpRoot, 'ui-quality-repair');
  const brief = '# Quality overview\nKeep the Add record action usable.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 1,
    model: 'stub-ui-repair',
    baseUrl: 'https://private.invalid/v1',
    temperature: 0.2,
    brief,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  try {
    const provider = createUiRepairProvider();
    const result = await runPipeline({
      targetDir,
      config,
      provider,
    });

    assert.equal(result.status, 'success');
    assert.match(provider.observed.promptText, /HIT_TARGET_TOO_SMALL/);
    assert.match(
      provider.observed.promptText,
      /quality-1-overview-(desktop|mobile)-round-0(?:-\d+)?\.png/,
    );
    assert.equal(provider.observed.imageCount, 2);
    assert.doesNotMatch(
      provider.observed.promptText,
      /private\.invalid|data:image|vibe-one-ui-quality-repair-/,
    );
    assert.equal(result.errorCode, undefined);
    assert.equal(result.uiQuality.summary.pass, true);
    assert.equal(result.qualityHistory.length, 2);
    assert.equal(result.qualityHistory[0].summary.pass, false);
    assert.equal(result.qualityHistory[1].summary.pass, true);

    const qualityDir = path.join(result.runDir, 'quality');
    const [roundZero, roundOne, history] = await Promise.all([
      fs.readFile(path.join(qualityDir, 'round-0.json'), 'utf8'),
      fs.readFile(path.join(qualityDir, 'round-1.json'), 'utf8'),
      fs.readFile(path.join(qualityDir, 'history.json'), 'utf8'),
    ]);
    const roundZeroEvidence = JSON.parse(roundZero);
    const roundOneEvidence = JSON.parse(roundOne);
    assert.equal(roundZeroEvidence.summary.pass, false);
    assert.equal(roundOneEvidence.summary.pass, true);
    assert.equal(JSON.parse(history).length, 2);
    const roundZeroScreenshots = roundZeroEvidence.results.map(
      (entry) => entry.screenshot,
    );
    const roundOneScreenshots = roundOneEvidence.results.map(
      (entry) => entry.screenshot,
    );
    assert.ok(roundZeroScreenshots.every((name) => /-round-0(?:-\d+)?\.png$/.test(name)));
    assert.ok(roundOneScreenshots.every((name) => /-round-1(?:-\d+)?\.png$/.test(name)));
    assert.equal(
      roundZeroScreenshots.some((name) => roundOneScreenshots.includes(name)),
      false,
    );
    const [roundZeroImage, roundOneImage] = await Promise.all([
      fs.readFile(path.join(qualityDir, roundZeroScreenshots[0])),
      fs.readFile(path.join(qualityDir, roundOneScreenshots[0])),
    ]);
    assert.ok(roundZeroImage.length > 0);
    assert.ok(roundOneImage.length > 0);
    assert.notDeepEqual(roundZeroImage, roundOneImage);

    const eventsText = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line));
    const qualityEvents = events.filter((event) => event.type === 'quality:audit');
    assert.equal(qualityEvents.length, 3);
    assert.match(qualityEvents[0].summary, /2 checks failing/);
    assert.match(qualityEvents[1].summary, /checks pass/);
    assert.match(qualityEvents[2].summary, /checks pass/);
    assert.ok(
      events.findIndex((event) => event === qualityEvents[0])
        < events.findIndex((event) => event === qualityEvents[1]),
    );
    assert.ok(
      events.findIndex((event) => event === qualityEvents[1])
        < events.findIndex((event) => event === qualityEvents[2]),
    );

    const report = await fs.readFile(path.join(result.runDir, 'DELIVERY_REPORT.md'), 'utf8');
    const publicEvidence = eventsText + '\n' + report;
    assert.doesNotMatch(
      publicEvidence,
      /private\.invalid|data:image|base64|vibe-one-ui-quality-repair-|[A-Z]:\\/i,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('exhausted UI quality review returns the stable failure code', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-ui-quality-failed-')),
  );
  const targetDir = path.join(tmpRoot, 'ui-quality-failed');
  const brief = '# Quality overview\nKeep the Add record action usable.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 0,
    model: 'stub-ui-failed',
    baseUrl: 'https://private.invalid/v1',
    temperature: 0.2,
    brief,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  try {
    const result = await runPipeline({
      targetDir,
      config,
      provider: createUiRepairProvider(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'UI_QUALITY_FAILED');
    assert.equal(result.uiQuality.summary.pass, false);
    assert.equal(result.qualityHistory.length, 1);
    assert.ok(result.qualityHistory[0].summary.failures.every(
      (failure) => failure.code === 'HIT_TARGET_TOO_SMALL',
    ));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('coded UI collector infrastructure errors stay fatal and skip repair', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-ui-collector-fatal-')),
  );
  const targetDir = path.join(tmpRoot, 'ui-collector-fatal');
  const brief = '# Expenses\nList expenses with a total and an Add button.\n';
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief);
  const provider = createStubProvider();
  const buildChat = provider.chat.bind(provider);
  let chatCalls = 0;
  provider.chat = async (request) => {
    chatCalls += 1;
    return buildChat(request);
  };
  const uiCollector = async () => {
    const error = new Error(
      'UI_QUALITY_ROUTE_INVALID: https://private.invalid D:\\private\\artifact',
    );
    error.code = 'UI_QUALITY_ROUTE_INVALID';
    throw error;
  };
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 1,
    model: 'stub-ui-collector-fatal',
    baseUrl: 'https://private.invalid/v1',
    temperature: 0.2,
    brief,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  try {
    const result = await runPipeline({
      targetDir,
      config,
      provider,
      uiCollector,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'UI_QUALITY_ROUTE_INVALID');
    assert.equal(chatCalls, 1, 'collector infrastructure failure must not call fixer');
    assert.equal(result.qualityHistory.length, 0);
    const events = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    assert.match(events, /"type":"fatal".*"code":"UI_QUALITY_ROUTE_INVALID"/);
    assert.doesNotMatch(events, /private\.invalid|D:\\private|artifact/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('visual reference passes on round zero with deterministic local scoring', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-visual-pass-')));
  const targetDir = path.join(tmpRoot, 'visual-pass');
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), '# 支出看板\n根据参考图生成响应式页面。\n');
  await writeVisualReference(targetDir);
  const loaded = await loadConfig(targetDir, { apiKey: 'stub-visual-key' });
  const config = {
    ...loaded,
    model: 'stub-visual',
    baseUrl: 'http://stub.local/v1',
    maxRepairRounds: 0,
    visualThreshold: 0.62,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  const result = await runPipeline({
    targetDir,
    config,
    provider: createVisualProvider(),
  });

  assert.equal(result.status, 'success');
  const history = JSON.parse(
    await fs.readFile(path.join(result.runDir, 'visual', 'comparisons.json'), 'utf8'),
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].round, 0);
  assert.equal(history[0].results[0].pass, true);
  assert.ok(history[0].results[0].score >= 0.62, JSON.stringify(history[0].results[0]));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('visual failure sends both images to the fixer and passes after one repair', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-one-visual-repair-')));
  const targetDir = path.join(tmpRoot, 'visual-repair');
  await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
  await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), '# 支出看板\n先生成后按参考图修复视觉。\n');
  await writeVisualReference(targetDir);
  const loaded = await loadConfig(targetDir, { apiKey: 'stub-visual-key' });
  const config = {
    ...loaded,
    model: 'stub-visual-repair',
    baseUrl: 'http://stub.local/v1',
    maxRepairRounds: 1,
    visualThreshold: 0.62,
    runsRoot: path.join(tmpRoot, 'runs'),
  };

  const result = await runPipeline({
    targetDir,
    config,
    provider: createVisualProvider({ repair: true }),
  });

  assert.equal(result.status, 'success');
  const history = JSON.parse(
    await fs.readFile(path.join(result.runDir, 'visual', 'comparisons.json'), 'utf8'),
  );
  assert.equal(history.length, 2);
  assert.equal(history[0].results[0].pass, false);
  assert.equal(history[1].results[0].pass, true);
  assert.ok(history[1].results[0].score > history[0].results[0].score);
  const firstActual = history[0].results[0].actualImage;
  const secondActual = history[1].results[0].actualImage;
  assert.notEqual(firstActual, secondActual);
  const [firstBytes, secondBytes] = await Promise.all([
    fs.readFile(path.join(result.runDir, 'screenshots', firstActual)),
    fs.readFile(path.join(result.runDir, 'screenshots', secondActual)),
  ]);
  assert.notDeepEqual(firstBytes, secondBytes);
  const report = await fs.readFile(path.join(result.runDir, 'DELIVERY_REPORT.md'), 'utf8');
  assert.match(report, /### Round 0/);
  assert.match(report, /### Round 1/);
  assert.match(report, /Restored the blue and amber reference palette/i);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('e2e test is opt-in', () => {
  // Always-on marker so `npm test` shows the e2e suite exists but is gated.
  assert.ok(true);
  if (!ENABLED) console.log('  (e2e skipped; set VIBE_ONE_E2E=1 to run the full no-API integration test)');
});
