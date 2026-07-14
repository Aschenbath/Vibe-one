import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createConsoleServer } from '../src/console/server.js';
import { PROJECT_ROOT } from '../src/core/runContext.js';
import { writeReport } from '../src/reporter/deliveryReport.js';

const ENABLED = process.env.VIBE_ONE_CONSOLE_E2E === '1';
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64',
);

test('console package command is registered', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.console, 'node src/console/index.js');
  const css = await fs.readFile(path.join(PROJECT_ROOT, 'src', 'console', 'public', 'app.css'), 'utf8');
  assert.match(css, /^\s*--surface: #ffffff;\s*$/m);
});

test('browser console keeps the Product Lab workspace responsive and accessible', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-layout-')));
  const artifacts = process.env.VIBE_ONE_CONSOLE_ARTIFACTS;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(address.url);
    const desktopLayout = await desktop.evaluate(() => {
      const rail = document.querySelector('#history-drawer').getBoundingClientRect();
      const main = document.querySelector('.product-lab').getBoundingClientRect();
      const focus = document.querySelector('#focus-workspace').getBoundingClientRect();
      const brief = document.querySelector('#product-goal').getBoundingClientRect();
      const dropzone = document.querySelector('#reference-dropzone').getBoundingClientRect();
      return {
        historyCollapsed: document.querySelector('#history-toggle').getAttribute('aria-expanded') === 'false'
          && document.querySelector('#history-panel').hidden,
        railWidth: Math.round(rail.width),
        focusCentered: Math.abs((focus.left + focus.width / 2) - (main.left + main.width / 2)) <= 2,
        focusWidth: Math.round(focus.width),
        inputAboveFold: brief.bottom <= window.innerHeight,
        dropzoneAboveFold: dropzone.bottom <= window.innerHeight,
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    assert.deepEqual(desktopLayout, {
      historyCollapsed: true,
      railWidth: 72,
      focusCentered: true,
      focusWidth: 1180,
      inputAboveFold: true,
      dropzoneAboveFold: true,
      noHorizontalOverflow: true,
    });
    if (artifacts) await desktop.screenshot({ path: path.join(artifacts, 'product-studio-focus.png') });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(address.url);
    await mobile.getByRole('button', { name: '运行设置' }).click();
    assert.equal(await mobile.locator('#settings-drawer').evaluate((dialog) => dialog.open), true);
    const modeLabels = mobile.locator('#settings-drawer fieldset label');
    for (let index = 0; index < await modeLabels.count(); index += 1) {
      const box = await modeLabels.nth(index).boundingBox();
      assert.ok(box && box.height >= 44, `settings mode label ${index + 1} is ${box?.height}px tall`);
    }
    await mobile.getByRole('button', { name: '完成' }).click();
    await mobile.getByRole('button', { name: '展开历史' }).click();
    assert.equal(await mobile.locator('#history-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await mobile.locator('#history-panel').isVisible(), true);
    for (const selector of ['#brief', '#reference-trigger', '#launch-run']) {
      const control = mobile.locator(selector);
      await control.scrollIntoViewIfNeeded();
      assert.equal(await control.isVisible(), true);
      assert.equal(await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight;
      }), true);
    }
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    const reduced = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await reduced.goto(address.url);
    const durations = await reduced.locator('#focus-workspace').evaluate((element) => {
      const style = getComputedStyle(element);
      const normalize = (value) => value === '0.00001s' || value === '1e-05s' ? '0.01ms' : value;
      return {
        animation: normalize(style.animationDuration),
        transition: normalize(style.transitionDuration),
      };
    });
    assert.ok(['0s', '0.01ms'].includes(durations.animation));
    assert.ok(['0s', '0.01ms'].includes(durations.transition));
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser Focus composes a Product Studio brief and ordered storyboard', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-focus-')));
  const runsRoot = path.join(root, 'runs');
  let submittedBrief = '';
  let submittedReferences = [];
  const pipeline = async ({ config }) => {
    submittedBrief = config.brief;
    submittedReferences = config.references;
    const runDir = path.join(runsRoot, 'focus-brief-run');
    await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'logs', 'events.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(runDir, 'DELIVERY_REPORT.md'), '# Delivery Report\n- Status: **planned**\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 80));
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:done', summary: 'brief ready' });
    return {
      runId: 'focus-brief-run',
      runDir,
      status: 'planned',
    };
  };
  const app = createConsoleServer({ runsRoot, pipeline, env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(address.url);
    await page.getByRole('button', { name: '运行设置' }).click();
    await page.getByLabel('会话 API Key').fill('focus-secret');
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByLabel('产品目标').fill('发现并处置高风险会话');
    await page.getByRole('button', { name: '使用 SignalDesk 起点' }).click();
    await dispatchReferenceFiles(page, ['overview.png', 'detail.png']);
    await page.getByRole('button', { name: '将 detail.png 前移' }).click();
    await page.getByLabel('detail.png 页面角色').fill('风险会话详情');
    await page.getByRole('button', { name: '开始生成' }).click();
    await page.locator('#active-status').filter({ hasText: '规划完成' }).waitFor();

    assert.match(submittedBrief, /产品目标.*目标用户.*核心流程.*视觉方向/s);
    assert.match(submittedBrief, /发现并处置高风险会话/);
    assert.match(submittedBrief, /参考图 Storyboard[\s\S]*detail\.png.*风险会话详情/);
    assert.deepEqual(submittedReferences.map((item) => item.name), ['detail.png', 'overview.png']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser Studio Flow keeps mobile drawers accessible and mutually exclusive', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-flow-mobile-')));
  const runsRoot = path.join(root, 'runs');
  const pipeline = async ({ config }) => {
    const runDir = path.join(runsRoot, 'flow-mobile-run');
    await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'logs', 'events.jsonl'), '', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 80));
    config.onEvent({ ts: new Date().toISOString(), type: 'plan:done', summary: 'brief ready' });
    return { runId: 'flow-mobile-run', runDir, status: 'planned' };
  };
  const app = createConsoleServer({ runsRoot, pipeline, env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(address.url);
    await page.getByRole('button', { name: '运行设置' }).click();
    await page.getByLabel('会话 API Key').fill('flow-mobile-secret');
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByLabel('产品目标').fill('移动端抽屉验收');
    await page.getByRole('button', { name: '开始生成' }).click();
    await page.locator('#active-status').filter({ hasText: '规划完成' }).waitFor();

    await page.getByRole('button', { name: '打开生产时间线' }).click();
    assert.equal(await page.locator('body').getAttribute('data-drawer'), 'timeline');
    await page.getByRole('button', { name: '打开 Inspector' }).click();
    assert.equal(await page.locator('body').getAttribute('data-drawer'), 'inspector');
    assert.equal(await page.locator('.studio-timeline').evaluate((node) => getComputedStyle(node).transform !== 'none'), true);
    const undersized = await page.locator('button,a,input,textarea,select').evaluateAll((els) => els.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
    }).map((el) => `${el.tagName}#${el.id || ''}.${el.className || ''} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
    assert.deepEqual(undersized, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('body').getAttribute('data-drawer'), null);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser console submits a reference image and renders live evidence', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-browser-')));
  const runsRoot = path.join(root, 'runs');
  const artifacts = process.env.VIBE_ONE_CONSOLE_ARTIFACTS || path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });

  const previewServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><main><h1>生成产品预览</h1><button>添加支出</button></main></body></html>');
  });
  await new Promise((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
  const previewAddress = previewServer.address();
  const previewUrl = `http://127.0.0.1:${previewAddress.port}/`;

  let submittedBrief;
  let submittedReferences;
  const pipeline = async ({ config, planOnly }) => {
    submittedBrief = config.brief;
    submittedReferences = config.references;
    const runId = 'console-demo-2026-07-11T08-00-00';
    const timestamp = '2026-07-11T08:00:00.000Z';
    const runDir = path.join(runsRoot, runId);
    const events = [
      { ts: timestamp, type: 'plan:start', summary: 'planning from brief' },
      { ts: timestamp, type: 'plan:done', summary: '3 pages, 4 scenarios' },
      { ts: timestamp, type: 'build:start', summary: 'generating app files' },
      { ts: timestamp, type: 'review', summary: 'all checks pass' },
    ];
    await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'app'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'design.json'), JSON.stringify({
      available: true,
      summary: 'SignalDesk 风险会话工作台',
      pages: [
        { name: '风险总览', route: '/', purpose: '查看风险分布' },
        { name: '待办队列', route: '/queue', purpose: '筛选并处置会话' },
      ],
      scenarios: [],
      acceptance: [],
      productDesign: {},
    }), 'utf8');
    for (const event of events) config.onEvent(event);
    await fs.copyFile(
      path.join(PROJECT_ROOT, 'docs', 'screenshots', 'expense-home.png'),
      path.join(runDir, 'screenshots', 'expense-home.png'),
    );
    await fs.writeFile(
      path.join(runDir, 'DELIVERY_REPORT.md'),
      `# Delivery Report - ${runId}\n\n- Status: **${planOnly ? 'planned' : 'success'}**\n- Model: ${config.model} @ ${config.baseUrl}\n\n## Verification checks\n\n- [x] all checks pass\n`,
      'utf8',
    );
    const reportEvent = { ts: timestamp, type: 'report:written', summary: 'delivery report ready' };
    config.onEvent(reportEvent);
    await fs.writeFile(
      path.join(runDir, 'logs', 'events.jsonl'),
      [...events, reportEvent].map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
    return { runId, runDir, status: planOnly ? 'planned' : 'success' };
  };

  const app = createConsoleServer({
    runsRoot,
    pipeline,
    env: {},
    previewStart: async () => ({ url: previewUrl, stop() {} }),
  });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(address.url);
    await page.getByRole('button', { name: '运行设置' }).click({ timeout: 1_000 });
    await page.getByLabel('会话 API Key').fill('stub-secret');
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByLabel('任务名称').fill('SignalDesk 客服质检平台');
    await page.getByLabel('产品目标').fill('发现并处置高风险会话');
    await page.getByRole('button', { name: '使用 SignalDesk 起点' }).click();
    await dispatchReferenceFiles(page, ['overview.png', 'detail.png']);
    await page.locator('#reference-list').filter({ hasText: 'detail.png' }).waitFor({ timeout: 2_000 });
    await page.getByRole('button', { name: '将 detail.png 前移' }).click();
    await page.getByRole('button', { name: '开始生成' }).click();
    await page.locator('#active-status').filter({ hasText: '交付完成' }).waitFor();
    assert.match(submittedBrief, /产品目标[\s\S]*目标用户[\s\S]*核心流程[\s\S]*视觉方向/);
    assert.deepEqual(submittedReferences.map((item) => item.name), ['detail.png', 'overview.png']);
    assert.match(await page.locator('#event-log').innerText(), /正在理解需求与参考图/);
    assert.equal(
      await page.locator('[data-stage="quality"]').evaluate((element) => element.classList.contains('done')),
      false,
    );

    await page.getByRole('tab', { name: '证据' }).click();
    await page.getByRole('tab', { name: '参考图' }).click();
    const liveReferenceText = await page.locator('#reference-evidence').innerText();
    assert.match(liveReferenceText, /detail\.png/);
    assert.match(liveReferenceText, /overview\.png/);
    assert.doesNotMatch(liveReferenceText, /undefined/);

    await page.getByRole('tab', { name: '结果截图' }).click();
    await page.locator('#screenshots-grid img').waitFor();
    await page.getByRole('tab', { name: '交付报告' }).click();
    await page.locator('#report-content').filter({ hasText: 'Delivery Report' }).waitFor();
    await page.getByRole('tab', { name: '实时预览' }).click();
    await page.locator('#canvas-page').selectOption('/queue');
    await page.getByRole('button', { name: '启动预览' }).click();
    await page.frameLocator('#preview-frame').getByText('生成产品预览').waitFor();
    assert.match(await page.locator('#preview-frame').getAttribute('src'), /\/queue$/);

    const bodyText = await page.locator('body').innerText();
    assert.equal(bodyText.includes('stub-secret'), false);
    assert.equal(bodyText.includes('iVBOR'), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('#run-started').evaluate((element) => { element.textContent = '7月11日 16:00'; });
    await page.screenshot({ path: path.join(artifacts, 'console-desktop.png') });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(address.url);
    await mobile.getByRole('button', { name: '展开历史' }).click();
    await mobile.locator('#run-history .history-item').first().click();
    await mobile.locator('#flow-workspace').waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await mobile.locator('#new-run').isVisible(), true);
    await mobile.getByRole('button', { name: '收起历史' }).click();
    await mobile.getByRole('button', { name: '打开 Inspector' }).click();
    await mobile.getByRole('tab', { name: '证据' }).click();
    assert.equal(await mobile.getByRole('tab', { name: '实时预览' }).isVisible(), true);
    await mobile.keyboard.press('Escape');
    await mobile.getByRole('button', { name: '启动预览' }).click();
    await mobile.frameLocator('#preview-frame').getByText('生成产品预览').waitFor();
    await mobile.locator('#run-started').evaluate((element) => { element.textContent = '7月11日 16:00'; });
    await mobile.screenshot({ path: path.join(artifacts, 'console-mobile.png') });
  } finally {
    await browser.close();
    await app.close();
    await new Promise((resolve, reject) => previewServer.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser reference input serializes pending work before submit and clear', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-reference-race-')));
  const runsRoot = path.join(root, 'runs');
  let submittedReferences = [];
  const pipeline = async ({ config }) => {
    submittedReferences = config.references;
    return {
      runId: 'reference-race-run',
      runDir: path.join(runsRoot, 'reference-race-run'),
      status: 'planned',
    };
  };
  const app = createConsoleServer({ runsRoot, pipeline, env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.Image = class {
        naturalWidth = 1;
        naturalHeight = 1;
        set src(_value) {
          setTimeout(() => this.onload?.(), 120);
        }
      };
    });
    await page.goto(address.url);

    await page.evaluate(({ base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const input = document.querySelector('#reference-input');
      const dispatch = (names) => {
        const transfer = new DataTransfer();
        for (const name of names) transfer.items.add(new File([bytes], name, { type: 'image/png' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      dispatch(['one.png', 'two.png', 'three.png']);
      dispatch(['four.png', 'five.png', 'six.png']);
    }, { base64: ONE_PIXEL_PNG.toString('base64') });
    await page.waitForTimeout(500);
    const overlappingCount = await page.locator('#reference-list li').count();
    const overlappingMessage = await page.locator('#form-message').innerText();

    await page.locator('#new-run').evaluate((button) => button.click());
    await dispatchReferenceFiles(page, ['stale.png']);
    await page.locator('#new-run').evaluate((button) => button.click());
    await page.waitForTimeout(250);
    const staleCount = await page.locator('#reference-list li').count();

    await page.getByRole('button', { name: '运行设置' }).click();
    await page.getByLabel('会话 API Key').fill('race-secret');
    await page.getByRole('button', { name: '完成' }).click();
    await dispatchReferenceFiles(page, ['submit.png']);
    await page.locator('#run-form').evaluate((form) => form.requestSubmit());
    await page.waitForTimeout(600);

    assert.equal(overlappingCount, 3);
    assert.match(overlappingMessage, /最多上传 4 张参考图/);
    assert.equal(staleCount, 0);
    assert.deepEqual(submittedReferences.map((item) => item.name), ['submit.png']);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser reference input reports corrupt images and resets the picker', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-reference-corrupt-')));
  const app = createConsoleServer({ runsRoot: path.join(root, 'runs'), env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(address.url);
    await page.setInputFiles('#reference-input', {
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a png'),
    });
    await page.waitForTimeout(250);

    assert.equal(await page.locator('#form-message').innerText(), '无法读取图片：broken.png');
    assert.equal(await page.locator('#reference-input').inputValue(), '');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser console reconstructs persisted reference and visual evidence', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-visual-evidence-')));
  const runsRoot = path.join(root, 'runs');
  const runId = 'visual-history-run';
  const runDir = path.join(runsRoot, runId);
  const privateEndpoint = 'https://private.invalid/v1';
  const privatePath = 'D:\\private\\vibe-secret\\artifact.txt';
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'references'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  const reportCtx = {
    runId,
    runDir,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) {
      this.events.push({ ts: '2026-07-11T08:00:00.000Z', type, ...data });
    },
  };
  await writeReport(reportCtx, {
    config: {
      model: 'stub',
      baseUrl: privateEndpoint,
      stack: 'react-vite',
      maxRepairRounds: 0,
      references: [],
    },
    spec: { summary: 'Visual history' },
    status: 'success',
    rounds: 0,
    finalReview: { checks: [] },
    shots: [],
    scenarioResults: [],
    error: new Error(`upstream ${privateEndpoint} failed at ${privatePath}`),
  });
  await fs.writeFile(
    path.join(runDir, 'logs', 'events.jsonl'),
    reportCtx.events.map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  );
  await fs.writeFile(path.join(runDir, 'references', 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'screenshots', 'home-round-0.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'screenshots', 'home-round-1.png'), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(runDir, 'references', 'manifest.json'), JSON.stringify([{ name: 'home.png', type: 'image/png', width: 1, height: 1, bytes: ONE_PIXEL_PNG.length }]), 'utf8');
  await fs.mkdir(path.join(runDir, 'visual'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'visual', 'comparisons.json'), JSON.stringify([
    { round: 0, results: [{ page: '首页', referenceImage: 'home.png', actualImage: 'home-round-0.png', score: 0.48, structure: 0.52, color: 0.44, threshold: 0.62, pass: false }] },
    { round: 1, results: [{ page: '首页', referenceImage: 'home.png', actualImage: 'home-round-1.png', score: 0.83, structure: 0.86, color: 0.8, threshold: 0.62, pass: true }] },
  ]), 'utf8');
  const brokenRunId = 'broken-visual-run';
  const brokenRunDir = path.join(runsRoot, brokenRunId);
  await fs.mkdir(path.join(brokenRunDir, 'logs'), { recursive: true });
  await fs.writeFile(path.join(brokenRunDir, 'DELIVERY_REPORT.md'), '# Delivery Report\n- Status: **success**\n', 'utf8');
  await fs.writeFile(path.join(brokenRunDir, 'logs', 'events.jsonl'), `${JSON.stringify({ ts: '2026-07-11T07:00:00.000Z', type: 'report:written' })}\n`, 'utf8');

  const app = createConsoleServer({ runsRoot, env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  async function assertEvidence(page) {
    await page.getByRole('button', { name: '展开历史' }).click();
    await page.locator('#run-history .history-item').filter({ hasText: 'visual history run' }).click();
    await page.getByRole('navigation', { name: '生产时间线' }).waitFor();
    await page.getByRole('main', { name: '作品画布' }).waitFor();
    await page.getByRole('complementary', { name: '质量 Inspector' }).waitFor();
    await page.getByRole('button', { name: '手机视口' }).click();
    assert.equal(await page.locator('#product-canvas').getAttribute('data-viewport'), 'mobile');
    await page.getByRole('tab', { name: 'UI 质量' }).click();
    assert.match(await page.locator('#inspector-panel').innerText(), /44px/);
    await page.getByRole('tab', { name: '证据' }).click();
    await page.getByRole('tab', { name: '参考图' }).click();
    await page.locator('#reference-evidence img').waitFor();
    assert.match(await page.locator('#reference-evidence').innerText(), /home\.png.*1×1/);
    assert.match(await page.locator('#reference-evidence img').getAttribute('src'), /\/references\/home\.png$/);

    await page.getByRole('tab', { name: '视觉比较' }).click();
    const visual = page.locator('#visual-comparisons');
    await visual.getByLabel('首页 视觉一致性 0.83').waitFor();
    const text = await visual.innerText();
    assert.ok(text.indexOf('第 2 轮') < text.indexOf('第 1 轮'));
    assert.match(text, /0\.83/);
    assert.match(text, /结构 0\.86/);
    assert.match(text, /颜色 0\.80/);
    assert.match(text, /阈值 0\.62/);
    assert.match(text, /通过/);
    assert.match(text, /未通过/);
    assert.equal(await visual.locator('img').count(), 4);
    assert.match(await visual.locator('img').nth(1).getAttribute('src'), /\/screenshots\/home-round-1\.png$/);
    assert.match(await visual.locator('img').nth(3).getAttribute('src'), /\/screenshots\/home-round-0\.png$/);
    await page.locator('[data-tab="report"]').click();
    await page.locator('#report-content').filter({ hasText: 'Delivery Report' }).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /private\.invalid|vibe-secret/);
    await page.locator('[data-tab="visual"]').click();
  }

  try {
    const page = await browser.newPage();
    await page.goto(address.url);
    await assertEvidence(page);
    await page.reload();
    await assertEvidence(page);

    await page.route(`**/api/jobs/${brokenRunId}/visual`, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }),
    }));
    await page.locator('#run-history .history-item').filter({ hasText: 'broken visual run' }).click();
    await page.locator('#visual-comparisons').filter({ hasText: '视觉证据加载失败。' }).waitFor();
    assert.doesNotMatch(await page.locator('#visual-comparisons').innerText(), /第 2 轮|0\.83/);

    let visualRequests = 0;
    await page.route(`**/api/jobs/${runId}/visual`, async (route) => {
      visualRequests += 1;
      if (visualRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([{ round: 0, results: [{ page: '旧响应', referenceImage: 'home.png', actualImage: 'home-round-0.png', score: 0.11, structure: 0.11, color: 0.11, threshold: 0.62, pass: false }] }]),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ round: 1, results: [{ page: '最新响应', referenceImage: 'home.png', actualImage: 'home-round-1.png', score: 0.83, structure: 0.86, color: 0.8, threshold: 0.62, pass: true }] }]),
      });
    });
    await page.locator('#run-history .history-item').filter({ hasText: 'visual history run' }).click();
    await page.getByRole('tab', { name: '证据' }).click();
    await page.getByRole('tab', { name: '视觉比较' }).click();
    await page.locator('#visual-comparisons').filter({ hasText: '最新响应' }).waitFor();
    await page.waitForTimeout(300);
    assert.match(await page.locator('#visual-comparisons').innerText(), /最新响应/);
    assert.doesNotMatch(await page.locator('#visual-comparisons').innerText(), /旧响应/);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browser console does not expose unknown server copy', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-copy-safety-')));
  const runsRoot = path.join(root, 'runs');
  const runId = 'unknown-copy-run';
  const runDir = path.join(runsRoot, runId);
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'DELIVERY_REPORT.md'),
    '# Delivery Report\n- Status: **secret-status**\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(runDir, 'logs', 'events.jsonl'),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      type: 'mystery:event',
      summary: 'secret English summary',
    })}\n`,
    'utf8',
  );

  const app = createConsoleServer({ runsRoot, env: {} });
  const address = await app.listen(0);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(address.url);
    const historyText = await page.locator('#run-history').innerText();
    assert.match(historyText, /状态待确认/);
    assert.doesNotMatch(historyText, /secret-status/);

    await page.getByRole('button', { name: '展开历史' }).click();
    await page.locator('#run-history .history-item').first().click();
    await page.locator('#event-log').filter({ hasText: '事件已记录' }).waitFor();
    const eventText = await page.locator('#event-log').innerText();
    assert.match(eventText, /mystery:event/);
    assert.doesNotMatch(eventText, /secret English summary/);

    await page.getByRole('button', { name: '新建任务' }).click();
    await page.getByRole('button', { name: '运行设置' }).click();
    await page.getByLabel('会话 API Key').fill('copy-safety-key');
    await page.getByRole('button', { name: '完成' }).click();
    await page.route('**/api/jobs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'UPSTREAM_SECRET', message: 'secret upstream English' },
        }),
      });
    });
    await page.getByLabel('需求描述').fill('测试安全错误回退。');
    await page.getByRole('button', { name: '开始生成' }).click();
    await page.locator('#form-message').filter({ hasText: '本地工作台暂时无法完成请求，请查看事件记录。' }).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /secret upstream English|copy-safety-key/);
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('console browser test is opt-in', () => {
  assert.ok(true);
  if (!ENABLED) console.log('  (console e2e skipped; run npm run test:console:e2e to enable it)');
});

async function dispatchReferenceFiles(page, names) {
  await page.evaluate(({ base64, names: fileNames }) => {
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const transfer = new DataTransfer();
    for (const name of fileNames) transfer.items.add(new File([bytes], name, { type: 'image/png' }));
    const input = document.querySelector('#reference-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { base64: ONE_PIXEL_PNG.toString('base64'), names });
}
