import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { collectUiQuality } from '../src/runner/commands.js';
import {
  UI_VIEWPORTS,
  auditPageSnapshot,
  contrastRatio,
  summarizeUiAudit,
} from '../src/runner/uiQuality.js';

test('UI viewport and WCAG contrast contracts are deterministic', () => {
  assert.deepEqual(UI_VIEWPORTS, {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  });
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#000000', 'rgb(255, 255, 255)'), 21);
  assert.equal(contrastRatio('rgba(0, 0, 0, 1)', '#ffffff'), 21);
  const translucentForeground = contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff');
  const translucentBackground = contrastRatio('#000', 'rgba(0, 0, 0, 0.5)');
  const unrounded = contrastRatio('#767676', '#fff');
  assert.ok(translucentForeground > 3.9 && translucentForeground < 4.1);
  assert.ok(translucentBackground > 5.2 && translucentBackground < 5.4);
  assert.ok(unrounded > 4.54 && unrounded < 4.55);
  assert.notEqual(unrounded, 4.54);
  assert.equal(
    contrastRatio('#000', 'rgba(255, 255, 255, 0)', '#000'),
    1,
  );
  assert.equal(
    contrastRatio('#000', 'rgba(255, 255, 255, 0)', '#fff'),
    21,
  );
  assert.equal(contrastRatio('invalid', '#fff'), null);
});

test('audit reports the planned combined failures in stable order', () => {
  const result = auditPageSnapshot(greenSnapshot({
    page: '队列',
    route: '/queue',
    viewport: 'mobile',
    document: { scrollWidth: 430, clientWidth: 390 },
    overlaps: [{ a: '筛选', b: '搜索' }],
    interactive: [{ label: '筛选', width: 32, height: 32 }],
    textSamples: [{
      text: '辅助说明',
      foreground: '#999',
      background: '#fff',
      fontSize: 14,
      fontWeight: 400,
    }],
    visibleText: 'Card 1 placeholder text',
  }));

  assert.deepEqual(result.failures.map((failure) => failure.code), [
    'HORIZONTAL_OVERFLOW',
    'ELEMENT_OVERLAP',
    'HIT_TARGET_TOO_SMALL',
    'LOW_CONTRAST',
    'PLACEHOLDER_CONTENT',
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.page, '队列');
  assert.equal(result.route, '/queue');
  assert.equal(result.viewport, 'mobile');
});

test('audit reports every remaining page failure code in stable order', () => {
  const result = auditPageSnapshot(greenSnapshot({
    outOfBounds: [{ label: '保存', edge: 'right' }],
    landmarks: { main: false, navigation: false },
    headings: [{ level: 2, text: '无一级标题' }],
    requiredStates: ['loading', 'error'],
    stateEvidence: [{ name: 'loading', reachable: true }],
    mainRegion: { width: 0, height: 0, visibleText: '' },
    visibleText: 'TypeError: render failed\n    at App (src/App.jsx:10:2)',
    nativeControls: [{ label: '筛选', styled: false }],
    emojiIcons: [{ label: '保存', text: '💾' }],
    screenshot: { bytes: 0, width: 0, height: 0 },
  }));

  assert.deepEqual(result.failures.map((failure) => failure.code), [
    'ELEMENT_OUT_OF_BOUNDS',
    'LANDMARK_MISSING',
    'HEADING_HIERARCHY_INVALID',
    'STATE_UNREACHABLE',
    'EMPTY_MAIN_REGION',
    'ERROR_STACK_VISIBLE',
    'UNSTYLED_NATIVE_CONTROL',
    'EMOJI_ICON_VISIBLE',
    'SCREENSHOT_EMPTY',
  ]);
});

test('contrast audit uses WCAG AA thresholds and reports invalid colors', () => {
  const normal = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '普通正文',
      foreground: '#777',
      background: '#fff',
      fontSize: 16,
      fontWeight: 400,
    }],
  }));
  const large = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '大标题',
      foreground: '#777',
      background: '#fff',
      fontSize: 24,
      fontWeight: 400,
    }],
  }));
  const boldBelowBoundary = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '18px 粗体标题',
      foreground: '#777',
      background: '#fff',
      fontSize: 18,
      fontWeight: 700,
    }],
  }));
  const boldBoundary = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '18.66px 粗体标题',
      foreground: '#777',
      background: '#fff',
      fontSize: 18.66,
      fontWeight: 700,
    }],
  }));
  const boldLarge = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '19px 粗体标题',
      foreground: '#777',
      background: '#fff',
      fontSize: 19,
      fontWeight: 700,
    }],
  }));
  const invalid = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '颜色异常',
      foreground: 'not-a-color',
      background: '#fff',
      fontSize: 16,
      fontWeight: 400,
    }],
  }));
  const transparentOnDark = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '透明背景正文',
      foreground: '#000',
      background: 'rgba(255, 255, 255, 0)',
      backdrop: '#000',
      fontSize: 16,
      fontWeight: 400,
    }],
  }));

  assert.deepEqual(normal.failures.map((failure) => failure.code), ['LOW_CONTRAST']);
  assert.equal(large.pass, true);
  assert.deepEqual(
    boldBelowBoundary.failures.map((failure) => failure.code),
    ['LOW_CONTRAST'],
  );
  assert.equal(boldBoundary.pass, true);
  assert.equal(boldLarge.pass, true);
  assert.deepEqual(invalid.failures.map((failure) => failure.code), ['LOW_CONTRAST']);
  assert.match(invalid.failures[0].detail, /invalid color/i);
  assert.deepEqual(
    transparentOnDark.failures.map((failure) => failure.code),
    ['LOW_CONTRAST'],
  );
});

test('ordinary multilingual prose and optional empty evidence avoid false positives', () => {
  const result = auditPageSnapshot(greenSnapshot({
    visibleText: '欢迎使用质量工作台 😊 数据已同步',
    outOfBounds: undefined,
    overlaps: undefined,
    nativeControls: undefined,
    emojiIcons: undefined,
  }));

  assert.equal(result.pass, true);
  assert.deepEqual(result.failures, []);
});

test('a complete page snapshot and desktop-mobile summary pass', () => {
  const desktop = auditPageSnapshot(greenSnapshot());
  const mobile = auditPageSnapshot(greenSnapshot({
    viewport: 'mobile',
    document: { scrollWidth: 390, clientWidth: 390 },
    screenshot: { bytes: 8_000, width: 390, height: 844 },
  }));
  const summary = summarizeUiAudit(
    [desktop, mobile],
    [{ name: 'Workspace', route: '/' }],
  );

  assert.equal(desktop.pass, true);
  assert.deepEqual(desktop.failures, []);
  assert.deepEqual(desktop.metrics, {
    scrollWidth: 1440,
    clientWidth: 1440,
    interactiveCount: 1,
    textSampleCount: 1,
    screenshotBytes: 12_000,
  });
  assert.equal(summary.pass, true);
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.results.length, 2);
});

test('summary reports missing viewport evidence per page', () => {
  const desktop = auditPageSnapshot(greenSnapshot());
  const summary = summarizeUiAudit(
    [desktop],
    [{ name: 'Workspace', route: '/' }],
  );

  assert.equal(summary.pass, false);
  assert.deepEqual(summary.failures.map((failure) => failure.code), [
    'VIEWPORT_EVIDENCE_MISSING',
  ]);
  assert.equal(summary.failures[0].page, 'Workspace');
  assert.equal(summary.failures[0].route, '/');
  assert.equal(summary.failures[0].viewport, 'mobile');
});

test('collector captures ordered desktop-mobile evidence and closes browser resources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-ui-quality-collector-'));
  const server = http.createServer((request, response) => {
    const small = request.url?.startsWith('/small');
    const buttonSize = small ? 32 : 44;
    const html = [
      '<!doctype html><html><head><meta charset="utf-8"><style>',
      '*{box-sizing:border-box}body{margin:0;color:#17202a;background:#fff;font:16px Arial,sans-serif}',
      'nav{height:48px;padding:14px 20px;border-bottom:1px solid #d8dde5}',
      'main{padding:24px;min-height:500px}h1{margin:0 0 20px}',
      'button{width:', String(buttonSize), 'px;height:', String(buttonSize),
      'px;border:1px solid #173f9e;border-radius:6px;background:#2457d6;color:#fff}',
      '.ancestor-hidden{opacity:0}.audit-trap{width:20px;height:20px}',
      '</style></head><body>',
      '<nav aria-label="主导航">质量工作台</nav>',
      '<main><h1>', small ? '风险队列' : '健康概览', '</h1>',
      '<button data-ui-native-styled aria-label="筛选">筛选</button>',
      '<div class=ancestor-hidden><input class=audit-trap aria-label=祖先隐藏输入></div>',
      '<fieldset disabled><input class=audit-trap aria-label=禁用输入>',
      '<button class=audit-trap aria-label=禁用按钮>禁用按钮</button></fieldset>',
      '<p>真实运营数据已同步 😊</p>',
      '<section data-ui-state="loading">加载状态证据</section>',
      '</main></body></html>',
    ].join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port + '/';
  const pages = [
    { name: '风险队列', route: '/small' },
    { name: '健康概览', route: '/green' },
  ];

  try {
    const evidence = await collectUiQuality(
      { runDir: root, logEvent: async () => {} },
      baseUrl,
      pages,
      [{
        name: 'loading',
        trigger: 'Open the green page loading fixture',
        route: '/green',
        steps: [],
        expectText: '加载状态证据',
      }],
    );

    assert.deepEqual(evidence.results.slice(0, 4).map((result) => result.viewport), [
      'desktop',
      'mobile',
      'desktop',
      'mobile',
    ]);
    assert.deepEqual(evidence.results.slice(0, 4).map((result) => result.page), [
      '风险队列',
      '风险队列',
      '健康概览',
      '健康概览',
    ]);
    for (const result of evidence.results.slice(0, 2)) {
      assert.ok(result.failures.some((failure) => failure.code === 'HIT_TARGET_TOO_SMALL'));
    }
    assert.ok(evidence.results.slice(2, 4).every((result) => result.pass));
    const stateResults = evidence.results.slice(4);
    assert.equal(stateResults.length, 2);
    assert.ok(stateResults.every((result) => result.page === 'State: loading'));
    assert.ok(stateResults.every((result) => result.pass));
    const ignoredLabels = /祖先隐藏输入|禁用输入|禁用按钮/u;
    for (const [index, result] of evidence.results.slice(0, 4).entries()) {
      assert.equal(result.metrics.interactiveCount, 1);
      assert.equal(
        result.failures.filter((failure) => failure.code === 'HIT_TARGET_TOO_SMALL').length,
        index < 2 ? 1 : 0,
      );
      assert.equal(
        result.failures.filter(
          (failure) => failure.code === 'UNSTYLED_NATIVE_CONTROL',
        ).length,
        0,
      );
      assert.equal(
        result.failures.some((failure) => ignoredLabels.test(failure.detail ?? '')),
        false,
      );
    }
    assert.equal(evidence.summary.pass, false);
    assert.equal(
      evidence.summary.failures.filter(
        (failure) => failure.code === 'HIT_TARGET_TOO_SMALL',
      ).length,
      2,
    );

    const names = new Set();
    for (const result of evidence.results) {
      assert.equal(path.basename(result.screenshot), result.screenshot);
      assert.match(
        result.screenshot,
        result.page.startsWith('State:')
          ? /^quality-state-.+-(desktop|mobile)\.png$/u
          : /^quality-\d+-.+-(desktop|mobile)\.png$/u,
      );
      assert.equal(names.has(result.screenshot), false);
      names.add(result.screenshot);
      const file = path.join(root, 'quality', result.screenshot);
      const stat = await fs.stat(file);
      assert.ok(stat.size > 0);
      assert.ok(result.metrics.screenshotBytes > 0);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('collector audits only visible text and reports a hidden-only main as empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-ui-visible-text-'));
  const server = http.createServer((request, response) => {
    const hiddenOnly = request.url?.startsWith('/hidden-only');
    const main = hiddenOnly
      ? [
          '<main><div class=hidden-noise>Error: hidden',
          '<pre>    at fake.js:1:1</pre><span>Card 1 TODO</span></div></main>',
        ].join('')
      : [
          '<main><h1>Clean workspace</h1><p>Operational data is ready.</p>',
          '<div class=hidden-noise>Error: hidden',
          '<pre>    at fake.js:1:1</pre><span>Card 1 TODO</span></div>',
          '</main>',
        ].join('');
    const html = [
      '<!doctype html><html><head><meta charset=utf-8><style>',
      'body{margin:0;color:#17202a;background:#fff;font:16px Arial,sans-serif}',
      'nav{height:48px;padding:14px 20px}main{padding:24px;min-height:400px}',
      '.hidden-noise{opacity:0}',
      '</style></head><body><nav aria-label=Primary>Quality workspace</nav>',
      main,
      '</body></html>',
    ].join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/';

  try {
    const evidence = await collectUiQuality(
      { runDir: root, logEvent: async () => {} },
      baseUrl,
      [
        { name: 'Clean', route: '/clean' },
        { name: 'Hidden only', route: '/hidden-only' },
      ],
    );
    const clean = evidence.results.slice(0, 2);
    const hiddenOnly = evidence.results.slice(2);
    assert.ok(clean.every((result) => result.pass));
    assert.ok(clean.every((result) => !result.failures.some(
      (failure) => failure.code === 'PLACEHOLDER_CONTENT'
        || failure.code === 'ERROR_STACK_VISIBLE',
    )));
    assert.ok(hiddenOnly.every((result) => result.failures.some(
      (failure) => failure.code === 'EMPTY_MAIN_REGION',
    )));
    assert.ok(hiddenOnly.every((result) => !result.failures.some(
      (failure) => failure.code === 'PLACEHOLDER_CONTENT'
        || failure.code === 'ERROR_STACK_VISIBLE',
    )));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('collector rejects protocol-relative routes before escape navigation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontend-autopilot-ui-route-safety-'));
  let escapeRequests = 0;
  const baseServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><nav>Base</nav><main><h1>Base</h1></main>');
  });
  const escapeServer = http.createServer((_request, response) => {
    escapeRequests += 1;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><nav>Escape</nav><main><h1>Escape</h1></main>');
  });
  for (const server of [baseServer, escapeServer]) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const baseUrl = 'http://127.0.0.1:' + baseServer.address().port + '/';
  const escapeRoute = '//127.0.0.1:' + escapeServer.address().port + '/escape';

  try {
    await assert.rejects(
      collectUiQuality(
        { runDir: root, logEvent: async () => {} },
        baseUrl,
        [{ name: 'Escape', route: escapeRoute }],
      ),
      { code: 'UI_QUALITY_ROUTE_INVALID' },
    );
    assert.equal(escapeRequests, 0);
  } finally {
    await Promise.all([
      new Promise((resolve) => baseServer.close(resolve)),
      new Promise((resolve) => escapeServer.close(resolve)),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function greenSnapshot(overrides = {}) {
  return {
    page: 'Workspace',
    route: '/',
    viewport: 'desktop',
    document: { scrollWidth: 1440, clientWidth: 1440 },
    outOfBounds: [],
    overlaps: [],
    interactive: [{ label: '打开详情', width: 44, height: 44 }],
    textSamples: [{
      text: '风险会话',
      foreground: '#17202A',
      background: '#FFFFFF',
      fontSize: 16,
      fontWeight: 400,
    }],
    landmarks: { main: true, navigation: true },
    headings: [
      { level: 1, text: '质量工作台' },
      { level: 2, text: '风险趋势' },
    ],
    requiredStates: ['loading', 'empty'],
    stateEvidence: [
      { name: 'loading', reachable: true },
      { name: 'empty', reachable: true },
    ],
    mainRegion: {
      width: 1200,
      height: 700,
      visibleText: '真实运营指标与待处理会话',
    },
    visibleText: '真实运营指标与待处理会话',
    nativeControls: [{ label: '风险筛选', styled: true }],
    emojiIcons: [],
    screenshot: { bytes: 12_000, width: 1440, height: 900 },
    ...overrides,
  };
}
