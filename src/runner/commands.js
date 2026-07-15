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
import {
  UI_VIEWPORTS,
  auditPageSnapshot,
  summarizeUiAudit,
} from './uiQuality.js';

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

export async function collectUiQuality(
  ctx,
  baseUrl,
  pages,
  requiredStates = [],
) {
  const pageTargets = pages.map((pageSpec) => {
    const route = pageSpec.route ?? '/';
    return {
      pageSpec,
      route,
      url: localPreviewUrl(baseUrl, route),
    };
  });
  const qualityDir = ctx.qualityDir ?? path.join(ctx.runDir, 'quality');
  await fs.mkdir(qualityDir, { recursive: true });
  const stateSpecs = requiredStates.filter((state) => (
    state
    && typeof state === 'object'
    && typeof state.name === 'string'
    && typeof state.route === 'string'
    && Array.isArray(state.steps)
    && typeof state.expectText === 'string'
  ));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const results = [];

  try {
    for (let pageIndex = 0; pageIndex < pageTargets.length; pageIndex += 1) {
      const { pageSpec, route, url } = pageTargets[pageIndex];
      for (const [viewportName, viewport] of Object.entries(UI_VIEWPORTS)) {
        let browserPage;
        try {
          browserPage = await browser.newPage({ viewport });
          await browserPage.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          const snapshot = await browserPage.evaluate(collectDomSnapshot, {
            pageSpec: { name: pageSpec.name, route },
            viewportName,
            requiredStates: [],
          });
          const screenshot = [
            'quality',
            String(pageIndex + 1),
            qualitySlug(pageSpec.name),
            viewportName,
          ].join('-') + '.png';
          const screenshotFile = path.join(qualityDir, screenshot);
          const png = await browserPage.screenshot({
            path: screenshotFile,
            type: 'png',
            fullPage: true,
          });
          snapshot.screenshot = {
            bytes: png.length,
            width: Math.max(
              snapshot.document.scrollWidth,
              snapshot.document.clientWidth,
            ),
            height: Math.max(
              snapshot.document.scrollHeight,
              snapshot.document.clientHeight,
            ),
          };
          const audited = {
            ...auditPageSnapshot(snapshot),
            screenshot,
          };
          results.push(audited);
          if (ctx.logEvent) {
            await ctx.logEvent('ui:quality', {
              summary: pageSpec.name + ' ' + viewportName
                + ': ' + (audited.pass ? 'pass' : audited.failures.length + ' failures'),
            });
          }
        } finally {
          if (browserPage) await browserPage.close();
        }
      }
    }
    for (const state of stateSpecs) {
      for (const [viewportName, viewport] of Object.entries(UI_VIEWPORTS)) {
        const browserPage = await browser.newPage({ viewport });
        const pageName = `State: ${state.name}`;
        const screenshot = [
          'quality-state',
          qualitySlug(state.name),
          viewportName,
        ].join('-') + '.png';
        const screenshotFile = path.join(qualityDir, screenshot);
        const result = {
          page: pageName,
          route: state.route,
          viewport: viewportName,
          pass: false,
          failures: [],
          metrics: {
            scrollWidth: 0,
            clientWidth: viewport.width,
            interactiveCount: 0,
            textSampleCount: 0,
            screenshotBytes: 0,
          },
          screenshot,
        };
        try {
          await browserPage.goto(localPreviewUrl(baseUrl, state.route), {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          for (const step of state.steps) {
            const locator = await resolveTarget(browserPage, step);
            if (step.action === 'fill') {
              await locator.fill(String(step.value ?? ''), { timeout: 5_000 });
            } else {
              await locator.click({ timeout: 5_000 });
            }
            await browserPage.waitForTimeout(300);
          }
          await browserPage.getByText(state.expectText, { exact: false }).first().waitFor({
            state: 'visible',
            timeout: 5_000,
          });
          result.pass = true;
        } catch (error) {
          result.failures.push({
            code: 'STATE_UNREACHABLE',
            page: pageName,
            route: state.route,
            viewport: viewportName,
            detail: `${state.name}: ${String(error.message ?? error).split('\n')[0]}`,
          });
        } finally {
          const dimensions = await browserPage.evaluate(() => ({
            scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
            clientWidth: document.documentElement.clientWidth,
          })).catch(() => ({ scrollWidth: 0, clientWidth: viewport.width }));
          const png = await browserPage.screenshot({
            path: screenshotFile,
            type: 'png',
            fullPage: true,
          }).catch(() => null);
          result.metrics.scrollWidth = dimensions.scrollWidth;
          result.metrics.clientWidth = dimensions.clientWidth;
          result.metrics.screenshotBytes = png?.length ?? 0;
          await browserPage.close();
        }
        results.push(result);
        if (ctx.logEvent) {
          await ctx.logEvent('ui:state', {
            summary: `${state.name} ${viewportName}: ${result.pass ? 'pass' : 'FAIL'}`,
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  return {
    results,
    summary: summarizeUiAudit(results, pages),
  };
}

export async function compareReferencePages(
  ctx,
  baseUrl,
  pages,
  references,
  threshold = DEFAULT_VISUAL_THRESHOLD,
  round = 0,
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
        const actualName = `visual-${slug(planned.name)}-round-${round}.png`;
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

function localPreviewUrl(baseUrl, route) {
  let previewBase;
  try {
    previewBase = new URL(baseUrl);
  } catch {
    throw invalidUiQualityRoute();
  }

  const routeValue = String(route ?? '/');
  const routeForCheck = routeValue.trim();
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(routeForCheck)
    || routeForCheck.startsWith('//')
  ) {
    throw invalidUiQualityRoute();
  }

  let resolved;
  try {
    resolved = new URL(routeValue, previewBase);
  } catch {
    throw invalidUiQualityRoute();
  }
  if (resolved.origin !== previewBase.origin) {
    throw invalidUiQualityRoute();
  }
  return resolved.href;
}

function invalidUiQualityRoute() {
  const error = new Error(
    'UI_QUALITY_ROUTE_INVALID: route must stay on the preview origin',
  );
  error.code = 'UI_QUALITY_ROUTE_INVALID';
  return error;
}

function collectDomSnapshot({ pageSpec, viewportName, requiredStates }) {
  const interactiveSelector = [
    'button',
    'a[href]',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
  ].join(',');

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    for (let current = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      const inheritedStyle = getComputedStyle(current);
      if (
        inheritedStyle.display === 'none'
        || inheritedStyle.visibility === 'hidden'
        || inheritedStyle.visibility === 'collapse'
        || Number(inheritedStyle.opacity) <= 0
      ) {
        return false;
      }
      if (current === document.documentElement) break;
    }
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0
      && rect.height > 0
    );
  }

  function isEnabled(element) {
    let nativelyDisabled = false;
    try {
      nativelyDisabled = element.matches(':disabled');
    } catch {
      // Some non-HTML DOM implementations may not support :disabled.
    }
    return (
      !nativelyDisabled
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
    );
  }

  function collectVisibleText(rootElement) {
    if (!(rootElement instanceof Element) || !isVisible(rootElement)) return '';
    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
    );
    const chunks = [];
    let visitedNodes = 0;
    let collectedCharacters = 0;
    while (visitedNodes < 1_000 && collectedCharacters < 20_000) {
      const node = walker.nextNode();
      if (!node) break;
      visitedNodes += 1;
      if (!node.parentElement || !isVisible(node.parentElement)) continue;
      const value = String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value) continue;
      const remaining = 20_000 - collectedCharacters;
      const fragment = value.slice(0, remaining);
      chunks.push(fragment);
      collectedCharacters += fragment.length + 1;
    }
    return chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 20_000);
  }

  function label(element) {
    const text = (
      element.getAttribute('aria-label')
      || element.labels?.[0]?.innerText
      || element.innerText
      || element.value
      || element.getAttribute('placeholder')
      || element.getAttribute('role')
      || element.tagName.toLowerCase()
    );
    return String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function box(element) {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function parseCssColor(value) {
    const match = String(value ?? '').match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;
    const values = match[1]
      .replace('/', ' ')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (values.length < 3 || values.some((part) => !Number.isFinite(part))) {
      return null;
    }
    return [values[0], values[1], values[2], values[3] ?? 1];
  }

  function compositeColor(foreground, background) {
    const alpha = foreground[3];
    return [
      foreground[0] * alpha + background[0] * (1 - alpha),
      foreground[1] * alpha + background[1] * (1 - alpha),
      foreground[2] * alpha + background[2] * (1 - alpha),
      1,
    ];
  }

  function resolvedBackdrop(element) {
    const layers = [];
    for (let current = element.parentElement; current; current = current.parentElement) {
      const color = parseCssColor(getComputedStyle(current).backgroundColor);
      if (color && color[3] > 0) layers.push(color);
    }
    let result = [255, 255, 255, 1];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      result = compositeColor(layers[index], result);
    }
    return 'rgb(' + result.slice(0, 3).map(Math.round).join(', ') + ')';
  }

  function isStandaloneEmoji(text) {
    const value = String(text ?? '').trim();
    return (
      /\p{Extended_Pictographic}/u.test(value)
      && /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+$/u.test(value)
    );
  }

  function hasAuthorStyling(element) {
    if (element.hasAttribute('data-ui-native-styled')) return true;
    const style = getComputedStyle(element);
    return (
      style.appearance === 'none'
      || style.webkitAppearance === 'none'
      || Number.parseFloat(style.borderRadius) > 2
      || style.backgroundImage !== 'none'
      || Boolean(element.getAttribute('style')?.trim())
    );
  }

  const root = document.documentElement;
  const body = document.body;
  const documentWidth = Math.max(root.scrollWidth, root.clientWidth, innerWidth);
  const documentHeight = Math.max(root.scrollHeight, root.clientHeight, innerHeight);
  const interactiveElements = [...document.querySelectorAll(interactiveSelector)]
    .filter((element) => isVisible(element) && isEnabled(element))
    .slice(0, 150);
  const interactive = interactiveElements.map((element) => {
    const rect = box(element);
    return {
      label: label(element),
      width: rect.width,
      height: rect.height,
    };
  });

  const critical = [...new Set([
    ...document.querySelectorAll(
      'main,[role="main"],nav,[role="navigation"],h1,h2,h3,h4,h5,h6',
    ),
    ...interactiveElements,
  ])].filter(isVisible).slice(0, 150);

  const outOfBounds = [];
  for (const element of critical) {
    const rect = box(element);
    const edges = [];
    if (rect.left < -0.5) edges.push('left');
    if (rect.right > innerWidth + 0.5) edges.push('right');
    if (rect.top + scrollY < -0.5) edges.push('top');
    if (rect.bottom + scrollY > documentHeight + 0.5) edges.push('bottom');
    if (edges.length) outOfBounds.push({ label: label(element), edge: edges.join(',') });
  }

  const overlaps = [];
  for (let firstIndex = 0; firstIndex < critical.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < critical.length; secondIndex += 1) {
      const first = critical[firstIndex];
      const second = critical[secondIndex];
      if (first.contains(second) || second.contains(first)) continue;
      const a = box(first);
      const b = box(second);
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 0.5 && height > 0.5) {
        overlaps.push({ a: label(first), b: label(second) });
      }
    }
  }

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter(isVisible)
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: label(element),
    }));
  const mainElements = [...document.querySelectorAll('main,[role="main"]')]
    .filter(isVisible);
  const navigationElements = [
    ...document.querySelectorAll('nav,[role="navigation"]'),
  ].filter(isVisible);
  const mainElement = mainElements[0];
  const mainBox = mainElement ? box(mainElement) : null;

  const textSamples = [];
  const sampleKeys = new Set();
  for (const element of [...body.querySelectorAll('*')]) {
    if (textSamples.length >= 300) break;
    if (!isVisible(element)) continue;
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = ownText || (element.matches(interactiveSelector) ? label(element) : '');
    if (!text) continue;
    const style = getComputedStyle(element);
    const sample = {
      text: text.slice(0, 160),
      foreground: style.color,
      background: style.backgroundColor,
      backdrop: resolvedBackdrop(element),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: style.fontWeight === 'bold'
        ? 700
        : Number.parseFloat(style.fontWeight),
    };
    const key = Object.values(sample).join('|');
    if (sampleKeys.has(key)) continue;
    sampleKeys.add(key);
    textSamples.push(sample);
  }

  const nativeControls = [
    ...document.querySelectorAll('button,input,select,textarea'),
  ]
    .filter((element) => isVisible(element) && isEnabled(element))
    .map((element) => ({
      label: label(element),
      styled: hasAuthorStyling(element),
      signal: element.hasAttribute('data-ui-native-styled')
        ? 'data-ui-native-styled'
        : hasAuthorStyling(element) ? 'computed-style' : 'native-default',
    }));
  const emojiIcons = interactiveElements
    .map((element) => ({ label: label(element), text: label(element) }))
    .filter((entry) => isStandaloneEmoji(entry.text));

  const stateElements = [
    ...document.querySelectorAll('[data-ui-state],[data-state]'),
  ];
  const stateEvidence = requiredStates.map((name) => ({
    name,
    reachable: stateElements.some(
      (element) => (
        element.getAttribute('data-ui-state') === name
        || element.getAttribute('data-state') === name
      ) && isVisible(element),
    ),
  }));

  return {
    page: pageSpec.name,
    route: pageSpec.route,
    viewport: viewportName,
    document: {
      scrollWidth: documentWidth,
      clientWidth: root.clientWidth,
      scrollHeight: documentHeight,
      clientHeight: root.clientHeight,
    },
    outOfBounds,
    overlaps,
    interactive,
    textSamples,
    landmarks: {
      main: mainElements.length,
      navigation: navigationElements.length,
    },
    headings,
    requiredStates,
    stateEvidence,
    mainRegion: {
      width: mainBox?.width ?? 0,
      height: mainBox?.height ?? 0,
      visibleText: collectVisibleText(mainElement),
    },
    visibleText: collectVisibleText(body),
    nativeControls,
    emojiIcons,
  };
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

function qualitySlug(name) {
  const normalized = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return normalized || 'page';
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'page';
}
