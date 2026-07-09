// Runner: executes verification commands with full capture, plus preview + screenshots.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export async function runCommand(ctx, name, cmd, args, opts = {}) {
  const started = Date.now();
  await ctx.logEvent('cmd:start', { summary: `${cmd} ${args.join(' ')}`, name });

  const result = await new Promise((resolve) => {
    const child = spawn(cmd, args, {
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
      child.kill('SIGKILL');
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
  return runCommand(ctx, 'npm-install', NPM, ['install', '--no-audit', '--no-fund']);
}

export async function npmBuild(ctx) {
  return runCommand(ctx, 'npm-build', NPM, ['run', 'build']);
}

// Starts `vite preview`, waits for the local URL, returns { url, stop() }.
export async function startPreview(ctx, { port = 4173, timeoutMs = 30_000 } = {}) {
  await ctx.logEvent('preview:start', { summary: `starting preview on :${port}` });
  const child = spawn(NPM, ['run', 'preview', '--', '--port', String(port), '--strictPort'], {
    cwd: ctx.appDir,
    shell: false,
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await ctx.logEvent('preview:ready', { summary: url });
        return { url, output: () => output, stop: () => child.kill('SIGKILL') };
      }
    } catch {
      // not up yet
    }
    await delay(500);
  }
  child.kill('SIGKILL');
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

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
}
