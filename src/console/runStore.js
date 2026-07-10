import fs from 'node:fs/promises';
import path from 'node:path';
import { ConsoleError } from './errors.js';

export function createRunStore(runsRoot) {
  const root = path.resolve(runsRoot);

  async function listRuns() {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => readRun(entry.name, false)),
    );
    return runs
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function getRun(id) {
    const run = await readRun(id, true);
    if (!run) throw new ConsoleError('RUN_NOT_FOUND', 'Run not found.', 404);
    return run;
  }

  async function getPreviewTarget(id) {
    const run = await getRun(id);
    if (!run.previewEligible) {
      throw new ConsoleError('PREVIEW_UNAVAILABLE', 'Only successful full runs can be previewed.', 409);
    }
    return { id: run.id, status: run.status, appDir: jailed(resolveRunDir(id), 'app') };
  }

  async function readReport(id) {
    const file = jailed(resolveRunDir(id), 'DELIVERY_REPORT.md');
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new ConsoleError('REPORT_NOT_FOUND', 'Delivery report not found.', 404);
      throw error;
    }
  }

  async function readScreenshot(id, name) {
    const screenshotsDir = jailed(resolveRunDir(id), 'screenshots');
    const file = jailed(screenshotsDir, String(name));
    if (path.extname(file).toLowerCase() !== '.png') {
      throw new ConsoleError('SCREENSHOT_INVALID', 'Only PNG screenshots are available.', 400);
    }
    try {
      return await fs.readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ConsoleError('SCREENSHOT_NOT_FOUND', 'Screenshot not found.', 404);
      throw error;
    }
  }

  function resolveRunDir(id) {
    const value = String(id ?? '');
    if (!value || value.startsWith('.')) {
      throw new ConsoleError('RUN_INVALID', 'Run id is invalid.', 400);
    }
    return jailed(root, value);
  }

  async function readRun(id, includeEvents) {
    const runDir = resolveRunDir(id);
    let stat;
    try {
      stat = await fs.stat(runDir);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory()) return null;

    const [report, events, screenshots, appExists] = await Promise.all([
      readOptional(path.join(runDir, 'DELIVERY_REPORT.md')),
      readEvents(path.join(runDir, 'logs', 'events.jsonl')),
      readScreenshots(path.join(runDir, 'screenshots')),
      directoryExists(path.join(runDir, 'app')),
    ]);
    const status = report.match(/^- Status: \*\*(.+?)\*\*/m)?.[1] ?? inferStatus(events);
    const model = report.match(/^- Model: (.+?)(?: @ .+)?$/m)?.[1] ?? null;
    const createdAt = events[0]?.ts ?? stat.birthtime.toISOString();
    const completedAt = events.at(-1)?.ts ?? stat.mtime.toISOString();

    return {
      id,
      title: titleFromId(id),
      status,
      stage: status,
      model,
      createdAt,
      completedAt,
      repairCount: events.filter((event) => event.type === 'fix:applied').length,
      screenshots,
      hasReport: Boolean(report),
      previewEligible: status === 'success' && appExists,
      terminal: ['success', 'failed', 'planned'].includes(status),
      ...(includeEvents ? { events } : {}),
    };
  }

  return { listRuns, getRun, getPreviewTarget, readReport, readScreenshot };
}

function jailed(root, ...parts) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new ConsoleError('PATH_OUTSIDE_RUNS', 'Requested artifact is outside the runs directory.', 400);
  }
  return resolved;
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function readEvents(file) {
  const content = await readOptional(file);
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return [{ ts: event.ts, type: String(event.type || 'event'), summary: String(event.summary ?? '') }];
      } catch {
        return [];
      }
    });
}

async function readScreenshots(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function inferStatus(events) {
  if (events.some((event) => event.type === 'fatal' || event.type === 'repair:exhausted')) return 'failed';
  if (events.some((event) => event.type === 'report:written')) return 'complete';
  return 'unknown';
}

function titleFromId(id) {
  return id
    .replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, '')
    .replace(/-[a-f0-9]{8}$/i, '')
    .replace(/[-_]+/g, ' ');
}
