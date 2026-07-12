import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.ok(contrastRatio('#767676', '#fff') >= 4.5);
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
  const boldLarge = auditPageSnapshot(greenSnapshot({
    textSamples: [{
      text: '粗体标题',
      foreground: '#777',
      background: '#fff',
      fontSize: 18,
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

  assert.deepEqual(normal.failures.map((failure) => failure.code), ['LOW_CONTRAST']);
  assert.equal(large.pass, true);
  assert.equal(boldLarge.pass, true);
  assert.deepEqual(invalid.failures.map((failure) => failure.code), ['LOW_CONTRAST']);
  assert.match(invalid.failures[0].detail, /invalid color/i);
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
