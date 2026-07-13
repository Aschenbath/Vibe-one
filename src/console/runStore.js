import fs from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import { ConsoleError } from './errors.js';
import { sanitizeEvidenceText } from '../reporter/deliveryReport.js';

const EVIDENCE_BUNDLE_MARKER = '.evidence-bundle.json';
const EVIDENCE_BUNDLES_DIR = '.evidence-bundles';

const EVIDENCE_BUCKETS = new Map([
  ['quality', ['quality']],
  ['polish-quality', ['polish', 'quality']],
  ['polish-screenshots', ['polish', 'screenshots']],
  ['polish-visual', ['polish', 'visual']],
]);
const EVIDENCE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export function createRunStore(runsRoot, { evidenceFs = fs } = {}) {
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
    resolveRunDir(id);
    try {
      const prefix = await resolveEvidencePrefix(root, String(id), evidenceFs);
      const inspected = prefix
        ? await readJailedFile(root, [...prefix, 'DELIVERY_REPORT.md'], evidenceFs, 'utf8')
        : null;
      if (!inspected) throw new ConsoleError('REPORT_NOT_FOUND', 'Delivery report not found.', 404);
      return inspected.data;
    } catch (error) {
      if (error.code === 'ENOENT') throw new ConsoleError('REPORT_NOT_FOUND', 'Delivery report not found.', 404);
      throw error;
    }
  }

  async function readScreenshot(id, name) {
    const screenshotsDir = jailed(resolveRunDir(id), 'screenshots');
    const filename = String(name);
    const file = jailed(screenshotsDir, filename);
    if (path.extname(file).toLowerCase() !== '.png') {
      throw new ConsoleError('SCREENSHOT_INVALID', 'Only PNG screenshots are available.', 400);
    }
    try {
      const prefix = await resolveEvidencePrefix(root, String(id), evidenceFs);
      if (prefix && prefix.length > 1) {
        const committed = await readJailedFile(
          root,
          [...prefix, 'screenshots', filename],
          evidenceFs,
        );
        if (committed?.stat.isFile()) return committed.data;
        throw new ConsoleError('SCREENSHOT_NOT_FOUND', 'Screenshot not found.', 404);
      }
      if (!prefix) throw new ConsoleError('SCREENSHOT_NOT_FOUND', 'Screenshot not found.', 404);
      return await fs.readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ConsoleError('SCREENSHOT_NOT_FOUND', 'Screenshot not found.', 404);
      throw error;
    }
  }

  async function readReference(id, name) {
    const dir = jailed(resolveRunDir(id), 'references');
    const requested = jailed(dir, String(name));
    const manifest = await readReferences(dir);
    const item = manifest.find((entry) => entry.name === String(name));
    if (!item) {
      throw new ConsoleError('REFERENCE_NOT_FOUND', 'Reference image not found.', 404);
    }
    return { data: await fs.readFile(requested), type: item.type };
  }

  async function readVisualComparisons(id) {
    const content = await readOptional(
      jailed(resolveRunDir(id), 'visual', 'comparisons.json'),
    );
    if (!content) return [];
    const value = JSON.parse(content);
    return Array.isArray(value) ? value : [];
  }

  async function readDesign(id) {
    resolveRunDir(id);
    const value = await readSidecar(root, evidenceFs, String(id), 'design.json');
    return selectDesign(value);
  }

  async function readQuality(id) {
    resolveRunDir(id);
    const value = await readSidecar(root, evidenceFs, String(id), 'quality', 'summary.json');
    return selectQuality(value, id);
  }

  async function readPolish(id) {
    resolveRunDir(id);
    const value = await readSidecar(root, evidenceFs, String(id), 'polish', 'summary.json');
    return selectPolish(value, id);
  }

  async function readEvidence(id, bucket, name) {
    const parts = EVIDENCE_BUCKETS.get(String(bucket));
    if (!parts) {
      throw new ConsoleError('EVIDENCE_BUCKET_INVALID', 'Evidence bucket is invalid.', 400);
    }
    const filename = String(name ?? '');
    if (!filename || filename !== path.basename(filename)) {
      throw new ConsoleError('EVIDENCE_NAME_INVALID', 'Evidence filename is invalid.', 400);
    }
    const type = EVIDENCE_TYPES.get(path.extname(filename).toLowerCase());
    if (!type) {
      throw new ConsoleError('EVIDENCE_TYPE_INVALID', 'Evidence file type is invalid.', 400);
    }
    resolveRunDir(id);
    try {
      const prefix = await resolveEvidencePrefix(root, String(id), evidenceFs);
      if (!prefix) {
        throw new ConsoleError('EVIDENCE_NOT_FOUND', 'Evidence file not found.', 404);
      }
      const inspected = await readJailedFile(
        root,
        [...prefix, ...parts, filename],
        evidenceFs,
      );
      if (!inspected || !inspected.stat.isFile()) {
        throw new ConsoleError('EVIDENCE_NOT_FOUND', 'Evidence file not found.', 404);
      }
      return { data: inspected.data, type };
    } catch (error) {
      if (error instanceof ConsoleError) throw error;
      if (error.code === 'ENOENT') {
        throw new ConsoleError('EVIDENCE_NOT_FOUND', 'Evidence file not found.', 404);
      }
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

    const [report, events, screenshots, references, visualComparisons, appExists] = await Promise.all([
      readCommittedOptional(runDir, evidenceFs, 'DELIVERY_REPORT.md'),
      readEvents(path.join(runDir, 'logs', 'events.jsonl')),
      readScreenshots(path.join(runDir, 'screenshots')),
      readReferences(path.join(runDir, 'references')),
      readVisualComparisons(id),
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
      references,
      visualComparisons,
      hasReport: Boolean(report),
      previewEligible: status === 'success' && appExists,
      terminal: ['success', 'failed', 'planned'].includes(status),
      ...(includeEvents ? { events } : {}),
    };
  }

  return {
    listRuns,
    getRun,
    getPreviewTarget,
    readReport,
    readScreenshot,
    readReference,
    readVisualComparisons,
    readDesign,
    readQuality,
    readPolish,
    readEvidence,
  };
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

async function readCommittedOptional(runDir, fsOps, ...parts) {
  const root = path.dirname(runDir);
  const prefix = await resolveEvidencePrefix(root, path.basename(runDir), fsOps);
  if (!prefix) return '';
  const inspected = await readJailedFile(
    root,
    [...prefix, ...parts],
    fsOps,
    'utf8',
  );
  return inspected?.data ?? '';
}

async function resolveEvidencePrefix(root, runId, fsOps) {
  const inspected = await readJailedFile(
    root,
    [runId, EVIDENCE_BUNDLE_MARKER],
    fsOps,
    'utf8',
  );
  if (!inspected) {
    return await jailedDirectoryExists(root, [runId, EVIDENCE_BUNDLES_DIR], fsOps)
      ? null
      : [runId];
  }
  try {
    const marker = JSON.parse(inspected.data);
    const bundleId = String(marker?.bundleId ?? '');
    if (marker?.version !== 1 || !/^[a-f0-9-]{36}$/i.test(bundleId)) return null;
    return [runId, EVIDENCE_BUNDLES_DIR, bundleId];
  } catch {
    return null;
  }
}

async function jailedDirectoryExists(root, parts, fsOps) {
  const base = path.resolve(root);
  const consumed = [];
  let stat = null;
  for (const part of parts) {
    consumed.push(part);
    const file = jailed(base, ...consumed);
    try {
      stat = await fsOps.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new ConsoleError('EVIDENCE_LINK_REJECTED', 'Linked evidence is not available.', 400);
    }
  }
  return stat?.isDirectory() === true;
}

async function readEvents(file) {
  const content = await readOptional(file);
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return [{
          ts: event.ts,
          type: String(event.type || 'event'),
          summary: String(event.summary ?? ''),
          ...(event.code ? { code: String(event.code) } : {}),
        }];
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

async function readReferences(dir) {
  const content = await readOptional(path.join(dir, 'manifest.json'));
  if (!content) return [];
  const value = JSON.parse(content);
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    bytes: Number(item.bytes) || 0,
  }));
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

async function readSidecar(root, fsOps, ...parts) {
  const [runId, ...artifactParts] = parts;
  const prefix = await resolveEvidencePrefix(root, String(runId ?? ''), fsOps);
  if (!prefix) return null;
  const inspected = await readJailedFile(root, [...prefix, ...artifactParts], fsOps, 'utf8');
  if (!inspected) return null;
  if (!inspected.stat.isFile()) {
    throw new ConsoleError('EVIDENCE_JSON_INVALID', 'Evidence data is invalid.', 500);
  }
  try {
    return JSON.parse(inspected.data);
  } catch {
    throw new ConsoleError('EVIDENCE_JSON_INVALID', 'Evidence data is invalid.', 500);
  }
}

async function readJailedFile(root, parts, fsOps, encoding = null) {
  const base = path.resolve(root);
  let canonicalBase;
  try {
    canonicalBase = await fsOps.realpath(base);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  const consumed = [];
  let stat = null;
  let file = base;
  for (const part of parts) {
    consumed.push(part);
    file = jailed(base, ...consumed);
    try {
      stat = await fsOps.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new ConsoleError('EVIDENCE_LINK_REJECTED', 'Linked evidence is not available.', 400);
    }
  }

  const flags = process.platform === 'win32'
    ? 'r'
    : FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await fsOps.open(file, flags);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    if (error.code === 'ELOOP') {
      throw new ConsoleError('EVIDENCE_LINK_REJECTED', 'Linked evidence is not available.', 400);
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { data: null, stat: opened };
    requireSingleLink(opened);
    let canonicalFile;
    let current;
    try {
      canonicalFile = await fsOps.realpath(file);
      current = await fsOps.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw evidenceChanged();
      throw error;
    }
    if (!isContained(canonicalBase, canonicalFile)) {
      throw new ConsoleError('EVIDENCE_LINK_REJECTED', 'Linked evidence is not available.', 400);
    }
    requireSingleLink(current);
    if (current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw evidenceChanged();
    }
    const data = encoding ? await handle.readFile({ encoding }) : await handle.readFile();
    const after = await handle.stat();
    requireSingleLink(after);
    if (!sameStableFile(opened, after)) throw evidenceChanged();
    return { data, stat: opened };
  } finally {
    await handle.close().catch(() => {});
  }
}

function requireSingleLink(stat) {
  if (Number(stat.nlink) !== 1) {
    throw new ConsoleError('EVIDENCE_LINK_REJECTED', 'Linked evidence is not available.', 400);
  }
}

function isContained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  const leftIno = Number(left.ino);
  const rightIno = Number(right.ino);
  if (Number.isFinite(leftIno) && Number.isFinite(rightIno) && (leftIno !== 0 || rightIno !== 0)) {
    return Number(left.dev) === Number(right.dev) && leftIno === rightIno;
  }
  return Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function sameStableFile(left, right) {
  return sameFileIdentity(left, right)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function evidenceChanged() {
  return new ConsoleError('EVIDENCE_CHANGED', 'Evidence changed during secure read.', 409);
}

function selectDesign(value) {
  if (!value?.available) {
    return { available: false, summary: null, productDesign: null, pages: [], scenarios: [], acceptance: [] };
  }
  return {
    available: true,
    summary: safeText(value.summary, 1000) || null,
    productDesign: safeObject(value.productDesign),
    pages: (value.pages ?? []).map((item) => ({
      name: safeText(item?.name, 160),
      route: safeRoute(item?.route),
      purpose: safeText(item?.purpose, 500),
      mustContain: safeList(item?.mustContain),
      referenceImage: safeImageName(item?.referenceImage),
    })),
    scenarios: (value.scenarios ?? []).map((item) => ({
      name: safeText(item?.name, 160),
      route: safeRoute(item?.route),
      steps: (item?.steps ?? []).map((step) => ({
        action: safeText(step?.action, 40),
        target: safeText(step?.target, 240),
        ...(step?.value !== undefined ? { value: safeText(step.value, 240) } : {}),
      })),
      expectText: safeText(item?.expectText, 240),
    })),
    acceptance: safeList(value.acceptance),
  };
}

function selectQuality(value, id) {
  if (!value?.available) return { available: false, rounds: [], terminal: null };
  return {
    available: true,
    rounds: (value.rounds ?? []).map((item) => selectQualityRound(item, id, 'quality')),
    terminal: value.terminal
      ? selectQualityRound(value.terminal, id, value.terminal.bucket || 'quality')
      : null,
  };
}

function selectQualityRound(value, id, bucket) {
  const safeBucket = EVIDENCE_BUCKETS.has(bucket) ? bucket : 'quality';
  const results = (value?.results ?? []).map((item) => {
    const screenshot = safeImageName(item?.screenshot);
    return {
      page: safeText(item?.page, 160),
      route: safeRoute(item?.route),
      viewport: ['desktop', 'mobile'].includes(item?.viewport) ? item.viewport : 'unknown',
      pass: item?.pass === true,
      screenshot,
      ...(screenshot ? { screenshotUrl: evidenceUrl(id, safeBucket, screenshot) } : {}),
    };
  });
  const failures = (value?.summary?.failures ?? []).map((item) => {
    const screenshot = safeImageName(item?.screenshot);
    return {
      code: safeCode(item?.code, 'UI_QUALITY_FAILED'),
      page: safeText(item?.page, 160),
      viewport: ['desktop', 'mobile'].includes(item?.viewport) ? item.viewport : 'unknown',
      screenshot,
      ...(screenshot ? { screenshotUrl: evidenceUrl(id, safeBucket, screenshot) } : {}),
    };
  });
  const evidence = [...new Set((value?.evidence ?? []).map(safeImageName).filter(Boolean))]
    .map((file) => ({ file, url: evidenceUrl(id, safeBucket, file) }));
  return {
    round: typeof value?.round === 'string' ? safeText(value.round, 40) : finite(value?.round),
    summary: { pass: value?.summary?.pass === true, failureCount: failures.length, failures },
    results,
    evidence,
  };
}

function selectPolish(value, id) {
  if (!value?.available) {
    return {
      available: false, status: null, changedFiles: [], draft: null, candidate: null,
      failureCauseCode: null,
      recovery: { draftRetained: false, recoveryRequired: false },
    };
  }
  return {
    available: true,
    status: ['verified', 'promoted', 'failed'].includes(value.status) ? value.status : 'failed',
    changedFiles: (value.changedFiles ?? []).map(safeRelativeFile).filter(Boolean),
    draft: selectLineage(value.draft, id, 'screenshots'),
    candidate: selectLineage(value.candidate, id, 'polish-screenshots'),
    failureCauseCode: ['POLISH_FAILED', 'POLISH_ROLLBACK_FAILED'].includes(value.failureCauseCode)
      ? value.failureCauseCode
      : null,
    recovery: {
      draftRetained: value.recovery?.draftRetained === true,
      recoveryRequired: value.recovery?.recoveryRequired === true,
    },
  };
}

function selectLineage(value, id, bucket) {
  if (!value) return null;
  return {
    review: selectReview(value.review),
    evidence: [...new Set((value.evidence ?? []).map(safeImageName).filter(Boolean))]
      .map((file) => ({
        file,
        url: bucket === 'screenshots'
          ? `/api/jobs/${encodeURIComponent(id)}/screenshots/${encodeURIComponent(file)}`
          : evidenceUrl(id, bucket, file),
      })),
    visualEvidence: [...new Set((value.visualEvidence ?? []).map(safeImageName).filter(Boolean))]
      .map((file) => ({ file, url: evidenceUrl(id, 'polish-visual', file) })),
  };
}

function selectReview(value) {
  const checks = (value?.checks ?? []).map((item) => ({
    name: safeText(item?.name, 240),
    pass: item?.pass === true,
  }));
  return {
    pass: value?.pass === true,
    checkCount: checks.length,
    failedCount: checks.filter((item) => !item.pass).length,
    checks,
  };
}

function safeObject(value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = [
    'productType', 'targetUsers', 'tone', 'density', 'navigation', 'contentStrategy',
    'tokens', 'componentLanguage', 'requiredStates', 'responsiveRules',
  ];
  return Object.fromEntries(allowed
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, safeSelected(value[key])]));
}

function safeSelected(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return safeText(value, 500);
  if (typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeSelected(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:secret|token|key|credential|authorization|endpoint|baseurl|path|source|provider|raw|stack|api)/i.test(key))
      .slice(0, 100)
      .map(([key, item]) => [safeText(key, 80), safeSelected(item, depth + 1)]));
  }
  return null;
}

function safeText(value, maxLength = 500) {
  const normalized = String(value ?? '').split(String.fromCharCode(92)).join('/');
  return sanitizeEvidenceText(normalized, maxLength)
    .replace(
      /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*(?:\n\s+at\s+[^\n]*)+/gu,
      '[redacted stack]',
    )
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted-image]')
    .replace(/https?:\/\/[^\s`)'\"]+/gi, '[redacted-url]')
    .replace(/\b[A-Za-z]:\/[^\s`)'\"]+/g, '[redacted-path]')
    .replace(/(^|\s)\/(?:Users|home|tmp|private|var|etc|mnt|opt|root)\/[^\s`)'\"]+/g, '$1[redacted-path]')
    .replace(/(^|[^A-Za-z0-9._~-])(?:\/\/|\/)[^\s`)'"]+/g, '$1[redacted-path]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[redacted credential]')
    .replace(/base64/gi, '[redacted-encoding]')
    .slice(0, maxLength)
    .trim();
}

function safeList(value, maxLength = 500) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => safeText(item, maxLength));
}

function safeRoute(value) {
  const route = String(value ?? '/');
  return route.startsWith('/') && !route.startsWith('//') && !route.includes(String.fromCharCode(92))
    ? route.slice(0, 240)
    : '/';
}

function safeRelativeFile(value) {
  const file = String(value ?? '').split(String.fromCharCode(92)).join('/');
  if (!file || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return null;
  const normalized = path.posix.normalize(file);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return safeText(normalized, 240);
}

function safeImageName(value) {
  const name = path.posix.basename(path.win32.basename(String(value ?? '')));
  return EVIDENCE_TYPES.has(path.extname(name).toLowerCase()) ? safeText(name, 160) : null;
}

function safeCode(value, fallback) {
  const code = String(value ?? '');
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function evidenceUrl(id, bucket, file) {
  return `/api/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(bucket)}/${encodeURIComponent(file)}`;
}
