import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createConsoleServer } from '../src/console/server.js';
import { PROJECT_ROOT } from '../src/core/runContext.js';

const ENABLED = process.env.VIBE_ONE_CONSOLE_E2E === '1';

test('console package command is registered', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.console, 'node src/console/index.js');
});

test('browser console submits a brief and renders live evidence', { skip: !ENABLED, timeout: 60_000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-console-browser-')));
  const runsRoot = path.join(root, 'runs');
  const artifacts = process.env.VIBE_ONE_CONSOLE_ARTIFACTS || path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });

  const previewServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><main><h1>Generated preview</h1><button>Add expense</button></main></body></html>');
  });
  await new Promise((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
  const previewAddress = previewServer.address();
  const previewUrl = `http://127.0.0.1:${previewAddress.port}/`;

  const pipeline = async ({ config, planOnly }) => {
    const runId = `console-demo-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const runDir = path.join(runsRoot, runId);
    const events = [
      { ts: new Date().toISOString(), type: 'plan:start', summary: 'planning from brief' },
      { ts: new Date().toISOString(), type: 'plan:done', summary: '3 pages, 4 scenarios' },
      { ts: new Date().toISOString(), type: 'build:start', summary: 'generating app files' },
      { ts: new Date().toISOString(), type: 'review', summary: 'all checks pass' },
    ];
    await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'app'), { recursive: true });
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
    const reportEvent = { ts: new Date().toISOString(), type: 'report:written', summary: 'delivery report ready' };
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
    await page.getByLabel('API key').fill('stub-secret');
    await page.getByLabel('App brief').fill('Build a compact expense tracker.');
    await page.getByRole('button', { name: 'Launch run' }).click();
    await page.locator('#active-status').filter({ hasText: 'success' }).waitFor();
    assert.match(await page.locator('#event-log').innerText(), /planning from brief/i);
    assert.equal(
      await page.locator('[data-stage="repairing"]').evaluate((element) => element.classList.contains('done')),
      false,
    );

    await page.getByRole('tab', { name: /Shots/ }).click();
    await page.locator('#screenshots-grid img').waitFor();
    await page.getByRole('tab', { name: 'Report' }).click();
    await page.locator('#report-content').filter({ hasText: 'Delivery Report' }).waitFor();
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('button', { name: 'Launch preview' }).click();
    await page.frameLocator('#preview-frame').getByText('Generated preview').waitFor();

    assert.equal((await page.locator('body').innerText()).includes('stub-secret'), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'console-desktop.png'), fullPage: true });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(address.url);
    await mobile.locator('#run-history .history-item').first().click();
    await mobile.locator('#run-monitor').waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await mobile.locator('#new-run').isVisible(), true);
    assert.equal(await mobile.getByRole('tab', { name: /Preview/ }).isVisible(), true);
    await mobile.screenshot({ path: path.join(artifacts, 'console-mobile.png'), fullPage: true });
  } finally {
    await browser.close();
    await app.close();
    await new Promise((resolve, reject) => previewServer.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('console browser test is opt-in', () => {
  assert.ok(true);
  if (!ENABLED) console.log('  (console e2e skipped; run npm run test:console:e2e to enable it)');
});
