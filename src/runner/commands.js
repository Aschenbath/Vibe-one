// Runner: executes verification commands with full capture, plus preview + screenshots
// + planner-defined interaction scenarios.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  compareImageFiles,
  DEFAULT_VISUAL_THRESHOLD,
} from './visualCompare.js';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Node >= 20.12 refuses to spawn .cmd shims with shell:false (CVE-2024-27980 fix),
// so npm invocations on Windows must go through the shell. All our args are
// pipeline-controlled literals, never model output, so this is safe.
const NEEDS_SHELL = process.platform === 'win32';

export async function runCommand(ctx, name, cmd, args, opts = {}) {
  const started = Date.now();
  await ctx.logEvent('cmd:start', { summary: `${cmd} ${args.join(' ')}`, name });

  const result = await new Promise((resolve) => {
    // Node >= 20.12 refuses .cmd shims with shell:false (CVE-2024-27980 fix). In
    // shell mode we pass one pipeline-controlled literal string (never model output).
    const useShell = cmd === NPM && NEEDS_SHELL;
    const child = useShell
      ? spawn(`${cmd} ${args.join(' ')}`, {
          cwd: opts.cwd ?? ctx.appDir,
          shell: true,
          env: { ...process.env, CI: '1' },
          windowsHide: true,
        })
      : spawn(cmd, args, {
          cwd: opts.cwd ?? ctx.appDir,
          shell: false,
          env: { ...process.env, CI: '1' },
          windowsHide: true,
        });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      killTree(child);
      resolve({ exitCode: null, stdout, stderr: stderr + '\n[vibe-one] timed out', timedOut: true });
    }, opts.timeoutMs ?? 5 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: String(err), timedOut: false });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut: false });
    });
  });

  const record = {
    name,
    command: `${cmd} ${args.join(' ')}`,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
  };
  await fs.writeFile(
    path.join(ctx.logsDir, `${name}.log`),
    `$ ${record.command}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    'utf8',
  );
  await ctx.logEvent('cmd:done', { summary: `${name} exit=${result.exitCode}`, ...record });
  return { ...record, stdout: result.stdout, stderr: result.stderr };
}

export async function npmInstall(ctx) {
  // --ignore-scripts: model-influenced trees must never run lifecycle scripts.
  return runCommand(ctx, 'npm-install', NPM, ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
}

export async function npmBuild(ctx) {
  return runCommand(ctx, 'npm-build', NPM, ['run', 'build']);
}

// Kills the whole process tree (npm shim -> node -> vite) on Windows and POSIX.
function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

// Finds an OS-assigned free port so parallel/dirty runs never collide.
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Starts `vite preview` on a free port, waits for readiness, returns { url, stop() }.
export async function startPreview(ctx, { timeoutMs = 30_000 } = {}) {
  const port = await getFreePort();
  await ctx.logEvent('preview:start', { summary: `starting preview on :${port}` });
  const previewArgs = ['run', 'preview', '--', '--port', String(port), '--strictPort'];
  const child = NEEDS_SHELL
    ? spawn(`${NPM} ${previewArgs.join(' ')}`, { cwd: ctx.appDir, shell: true, windowsHide: true })
    : spawn(NPM, previewArgs, { cwd: ctx.appDir, shell: false, windowsHide: true });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await ctx.logEvent('preview:ready', { summary: url });
        return { url, output: () => output, stop: () => killTree(child) };
      }
    } catch {
      // not up yet
    }
    await delay(500);
  }
  killTree(child);
  throw new Error(`preview server did not become ready on ${url}\n${output.slice(-2000)}`);
}

// Screenshots each route with Playwright; also returns visible page text for the reviewer.
export async function screenshotPages(ctx, baseUrl, pages, viewport) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  const shots = [];
  try {
    for (const p of pages) {
      const route = p.route?.startsWith('/') ? p.route : `/${p.route ?? ''}`;
      const url = new URL(route, baseUrl).href;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      const file = path.join(ctx.screenshotsDir, `${slug(p.name)}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const stat = await fs.stat(file);
      const text = await page.evaluate(() => document.body.innerText);
      shots.push({ page: p.name, route, file, bytes: stat.size, text });
      await ctx.logEvent('screenshot', { summary: `${p.name} -> ${stat.size} bytes` });
    }
  } finally {
    await browser.close();
  }
  return shots;
}

export async function compareReferencePages(
  ctx,
  baseUrl,
  pages,
  references,
  threshold = DEFAULT_VISUAL_THRESHOLD,
) {
  const mapped = pages.filter((page) => page.referenceImage);
  if (!mapped.length) return [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const planned of mapped) {
      const reference = references.find((item) => item.name === planned.referenceImage);
      if (!reference) {
        results.push({
          page: planned.name,
          referenceImage: planned.referenceImage,
          pass: false,
          score: 0,
          structure: 0,
          color: 0,
          threshold,
          error: 'mapped reference missing',
        });
        await ctx.logEvent('visual:compare', {
          code: 'REFERENCE_MISSING',
          summary: `${planned.name}: mapped reference missing`,
        });
        continue;
      }
      const page = await browser.newPage({
        viewport: { width: reference.width, height: reference.height },
      });
      try {
        const route = planned.route?.startsWith('/')
          ? planned.route
          : `/${planned.route ?? ''}`;
        await page.goto(new URL(route, baseUrl).href, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        const actualName = `visual-${slug(planned.name)}.png`;
        const actualFile = path.join(ctx.screenshotsDir, actualName);
        await page.screenshot({ path: actualFile, fullPage: false });
        const scores = await compareImageFiles(page, {
          referenceFile: reference.file,
          actualFile,
        });
        const result = {
          page: planned.name,
          route,
          referenceImage: reference.name,
          actualImage: actualName,
          threshold,
          ...scores,
          pass: scores.score >= threshold,
        };
        results.push(result);
        await ctx.logEvent('visual:compare', {
          summary: `${planned.name}: ${scores.score.toFixed(3)} / ${threshold.toFixed(2)}`,
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

// Executes planner-defined interaction scenarios:
// { name, route, steps: [{ action: 'click'|'fill', target, value? }], expectText }
// `target` is user-visible text (button/link label) or an input placeholder/label.
export async function runScenarios(ctx, baseUrl, scenarios, viewport) {
  if (!scenarios?.length) return [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const sc of scenarios) {
      const page = await browser.newPage({ viewport });
      const result = { name: sc.name, pass: false, error: null };
      try {
        const route = sc.route?.startsWith('/') ? sc.route : `/${sc.route ?? ''}`;
        await page.goto(new URL(route, baseUrl).href, { waitUntil: 'networkidle', timeout: 30_000 });
        for (const step of sc.steps ?? []) {
          const locator = await resolveTarget(page, step);
          if (step.action === 'fill') await locator.fill(String(step.value ?? ''), { timeout: 5_000 });
          else await locator.click({ timeout: 5_000 });
          await page.waitForTimeout(300);
        }
        if (sc.expectText) {
          const body = await page.evaluate(() => document.body.innerText);
          if (!body.includes(sc.expectText)) {
            throw new Error(`expected text not found after steps: "${sc.expectText}"`);
          }
        }
        result.pass = true;
        const file = path.join(ctx.screenshotsDir, `scenario-${slug(sc.name)}.png`);
        await page.screenshot({ path: file, fullPage: true });
      } catch (err) {
        result.error = err.message.split('\n')[0];
      } finally {
        await page.close();
      }
      results.push(result);
      await ctx.logEvent('scenario', { summary: `${sc.name}: ${result.pass ? 'pass' : `FAIL (${result.error})`}` });
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function resolveTarget(page, step) {
  if (step.action === 'fill') {
    const byPlaceholder = page.getByPlaceholder(step.target);
    if (await byPlaceholder.count()) return byPlaceholder.first();
    const byLabel = page.getByLabel(step.target);
    if (await byLabel.count()) return byLabel.first();
    return page.locator(`input, textarea, select`).filter({ hasText: step.target }).first();
  }
  const byRole = page.getByRole('button', { name: step.target });
  if (await byRole.count()) return byRole.first();
  return page.getByText(step.target, { exact: false }).first();
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'page';
}
