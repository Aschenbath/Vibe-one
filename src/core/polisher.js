// Polisher staging: isolate a bounded candidate before explicit promotion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parseFileBlocks, safeJoin } from './builder.js';
import {
  gatherSource,
  sanitizeUiFailure,
  UI_EVIDENCE_LIMITS,
  validateUiEvidenceFiles,
} from './fixer.js';

export const POLISH_LIMITS = Object.freeze({
  maxFiles: 4,
  maxCharacters: 18_000,
  maxRounds: 1,
});

const DISPOSABLE_SEGMENTS = new Set(['node_modules', 'dist', '.vite']);
const SCREENSHOT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export const POLISHER_SYSTEM = `You are the single-pass UI polisher of a bounded app-replication pipeline.
Improve only visual hierarchy, typography, spacing, density, component consistency,
state presentation, and responsive behavior. Preserve every approved feature, route,
interaction, data shape, and state transition.

Do not add features/routes/dependencies/network/backend functionality.
Available dependencies remain fixed. Never write package.json, lockfiles, Vite config,
environment files, node_modules, or build output.

OUTPUT FORMAT - emit complete corrected files only, with no prose or markdown fences:
=== FILE: relative/path
<full corrected file content>
=== END ===

Touch as few files as possible. Hard limit: at most 4 files and 18,000 characters total.`;

export async function polish(ctx, provider, evidence = {}) {
  await ctx.logEvent('polish:start', {
    summary: 'applying one bounded UI polish pass',
  });
  const source = await gatherSource(ctx.appDir);
  const user = await buildPolishEvidence(ctx, evidence, source);
  const { content, usage } = await provider.chat({ system: POLISHER_SYSTEM, user });
  ctx.addUsage(usage);

  const files = parseFileBlocks(String(content ?? ''));
  if (files.length === 0) throw polishOutputInvalid();
  validatePolishFiles(files, ctx.polishCandidateDir);

  await createPolishCandidate(ctx);
  await applyPatch({ ...ctx, appDir: ctx.polishCandidateDir }, files);
  const changed = files.map((file) => file.path);
  await ctx.logEvent('polish:applied', {
    summary: `${changed.length} files applied to isolated candidate`,
  });
  return changed;
}

export function validatePolishFiles(files, candidateRoot = process.cwd()) {
  if (!Array.isArray(files) || files.length === 0) {
    throw polishOutputLimit('polish files must be a non-empty array');
  }
  if (files.length > POLISH_LIMITS.maxFiles) {
    throw polishOutputLimit(
      'received ' + files.length + ' files; limit is ' + POLISH_LIMITS.maxFiles,
    );
  }

  let characters = 0;
  for (const file of files) {
    if (
      !file
      || typeof file.path !== 'string'
      || !file.path.trim()
      || typeof file.content !== 'string'
    ) {
      throw polishOutputLimit('every polish file requires a path and string content');
    }
    characters += file.content.length;
  }
  if (characters > POLISH_LIMITS.maxCharacters) {
    throw polishOutputLimit(
      'received ' + characters + ' content characters; limit is '
      + POLISH_LIMITS.maxCharacters,
    );
  }

  for (const file of files) {
    try {
      safeJoin(candidateRoot, file.path);
    } catch {
      throw polishOutputLimit('unsafe or pipeline-owned file path: ' + file.path);
    }
  }
  return files;
}

export async function createPolishCandidate(ctx, operations = fs) {
  assertOwnedPolishPaths(ctx);
  await assertPolishSourceSafe(ctx.appDir, operations);
  await operations.rm(ctx.polishCandidateDir, { recursive: true, force: true });
  await assertPolishSourceSafe(ctx.appDir, operations);
  await operations.cp(ctx.appDir, ctx.polishCandidateDir, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(ctx.appDir, source);
      if (!relative) return true;
      return !relative.split(path.sep).some(
        (segment) => DISPOSABLE_SEGMENTS.has(segment.toLowerCase()),
      );
    },
  });
  return ctx.polishCandidateDir;
}

export async function promotePolishCandidate(ctx, operations = fs) {
  assertOwnedPolishPaths(ctx);
  assertOwnedChild(ctx.polishDir, ctx.draftAppDir, 'draftAppDir');

  const candidate = await operations.stat(ctx.polishCandidateDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!candidate?.isDirectory()) {
    const error = new Error('POLISH_CANDIDATE_MISSING: polish candidate directory is missing');
    error.code = 'POLISH_CANDIDATE_MISSING';
    throw error;
  }

  await operations.rm(ctx.draftAppDir, { recursive: true, force: true });
  await operations.rename(ctx.appDir, ctx.draftAppDir);
  try {
    await operations.rename(ctx.polishCandidateDir, ctx.appDir);
  } catch (error) {
    try {
      await operations.rename(ctx.draftAppDir, ctx.appDir);
    } catch {
      const rollbackError = new Error(
        'POLISH_ROLLBACK_FAILED: draft retained; manual recovery required',
      );
      rollbackError.code = 'POLISH_ROLLBACK_FAILED';
      rollbackError.draftRetained = true;
      rollbackError.recoveryRequired = true;
      throw rollbackError;
    }
    throw error;
  }
  return ctx.appDir;
}

async function assertPolishSourceSafe(sourceRoot, operations = fs) {
  const entries = await operations.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw polishSourceLinkUnsafe();
    const source = path.join(sourceRoot, entry.name);
    const stats = await operations.lstat(source);
    if (stats.isSymbolicLink()) throw polishSourceLinkUnsafe();
    if (stats.isDirectory()) await assertPolishSourceSafe(source, operations);
  }
}

async function buildPolishEvidence(ctx, evidence, source) {
  const screenshots = await resolveEvidenceScreenshots(ctx, evidence.screenshots ?? []);
  const spec = sanitizeApprovedSpec(evidence.spec);
  const uiQuality = sanitizeUiQuality(evidence.uiQuality);
  const visualResults = sanitizeVisualResults(evidence.visualResults);
  const text = [
    'Approved spec:',
    JSON.stringify(spec.contract, null, 2),
    '',
    'Approved Product Design:',
    JSON.stringify(spec.productDesign, null, 2),
    '',
    'Current model-authored source (authoritative; edit only these existing app files):',
    sanitizeSourceEvidence(source),
    '',
    'Desktop/mobile screenshot identifiers:',
    screenshots.map((item) => `- ${item.filename}`).join('\n') || '- none',
    '',
    'Structured UI audit summary:',
    JSON.stringify(uiQuality, null, 2),
    '',
    'Optional visual comparison evidence:',
    JSON.stringify(visualResults, null, 2),
    '',
    'Polish hierarchy, typography, spacing, density, component consistency, state presentation, and responsive behavior only.',
    'Do not add features/routes/dependencies/network/backend functionality.',
    'Return at most 4 complete files and 18,000 content characters.',
  ].join('\n');
  const parts = [{ type: 'text', text }];
  for (const screenshot of screenshots) {
    const bytes = await fs.readFile(screenshot.file);
    if (bytes.length > UI_EVIDENCE_LIMITS.maxFileBytes) {
      throw polishEvidenceInvalid('screenshot exceeds the per-file limit');
    }
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${screenshot.type};base64,${bytes.toString('base64')}`,
      },
    });
  }
  return parts;
}

async function resolveEvidenceScreenshots(ctx, screenshots) {
  if (!Array.isArray(screenshots)) throw polishEvidenceInvalid('screenshots must be an array');
  if (screenshots.length > UI_EVIDENCE_LIMITS.maxFiles) {
    throw polishEvidenceInvalid('too many screenshots');
  }
  assertOwnedChild(ctx.runDir, ctx.qualityDir, 'qualityDir');
  assertOwnedChild(ctx.runDir, ctx.screenshotsDir, 'screenshotsDir');

  const resolved = [];
  const seenFiles = new Set();
  for (const screenshot of screenshots) {
    const raw = typeof screenshot === 'string' ? screenshot : screenshot?.filename;
    const filename = safeBasename(raw);
    const type = SCREENSHOT_TYPES.get(path.extname(filename).toLowerCase());
    if (!raw || raw !== filename || !type) {
      throw polishEvidenceInvalid('screenshot identifier must be a safe image basename');
    }
    const candidates = [
      path.join(ctx.qualityDir, filename),
      path.join(ctx.screenshotsDir, filename),
    ];
    let file;
    for (const candidate of candidates) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) {
        file = candidate;
        break;
      }
    }
    if (!file) throw polishEvidenceInvalid('screenshot is unavailable');
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    resolved.push({ filename, file, type });
  }
  await validateUiEvidenceFiles(resolved.map((item) => ({ actualFile: item.file })));
  return resolved;
}

function sanitizeApprovedSpec(spec = {}) {
  return {
    contract: sanitizeEvidenceValue({
      summary: spec?.summary,
      pages: spec?.pages,
      scenarios: spec?.scenarios,
    }),
    productDesign: sanitizeEvidenceValue(spec?.productDesign ?? {}),
  };
}

function sanitizeUiQuality(uiQuality = {}) {
  const summary = uiQuality?.summary ?? uiQuality ?? {};
  return {
    pass: Boolean(summary.pass),
    failures: Array.isArray(summary.failures)
      ? summary.failures.slice(0, 50).map(sanitizeUiFailure)
      : [],
  };
}

function sanitizeVisualResults(visualResults = []) {
  if (!Array.isArray(visualResults)) return [];
  return visualResults.slice(0, 50).map((result) => ({
    page: safeEvidenceText(result?.page, 120),
    score: safeNumber(result?.score),
    threshold: safeNumber(result?.threshold),
    structure: safeNumber(result?.structure),
    color: safeNumber(result?.color),
    pass: Boolean(result?.pass),
    referenceImage: safeBasename(result?.referenceImage),
  }));
}

function sanitizeEvidenceValue(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeEvidenceValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:apiKey|baseUrl|endpoint|stack|actualFile|referenceFile|file|path)$/i.test(key)) {
        continue;
      }
      safe[key] = sanitizeEvidenceValue(item, depth + 1);
    }
    return safe;
  }
  if (typeof value === 'string') return safeEvidenceText(value, 1000);
  if (typeof value === 'number') return safeNumber(value);
  if (typeof value === 'boolean' || value == null) return value;
  return safeEvidenceText(value, 200);
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function safeBasename(value) {
  return path.posix.basename(path.win32.basename(String(value ?? '')));
}

function safeEvidenceText(value, maxLength) {
  return redactSensitiveEvidence(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeSourceEvidence(value) {
  return redactSensitiveEvidence(value);
}

function redactSensitiveEvidence(value) {
  return String(value ?? '')
    .replace(
      /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*(?:\n\s+at\s+[^\n]*)+/gu,
      '[redacted stack]',
    )
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/giu, '[redacted]')
    .replace(/https?:\/\/[^\s'"]+/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s'"]+/gu, '[redacted]')
    .replace(/(^|[\s'"])\/(?:[^/\s'"]+\/)+[^\s'"]+/gu, '$1[redacted]');
}

function assertOwnedPolishPaths(ctx) {
  assertOwnedChild(ctx.runDir, ctx.polishDir, 'polishDir');
  assertOwnedChild(ctx.polishDir, ctx.polishCandidateDir, 'polishCandidateDir');
  assertOwnedChild(ctx.runDir, ctx.appDir, 'appDir');
}

function assertOwnedChild(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('unsafe owned path for ' + label);
  }
}

function polishOutputLimit(detail) {
  const error = new Error('POLISH_OUTPUT_LIMIT: ' + detail);
  error.code = 'POLISH_OUTPUT_LIMIT';
  return error;
}

function polishSourceLinkUnsafe() {
  const error = new Error('POLISH_SOURCE_LINK_UNSAFE: linked source entries are not allowed');
  error.code = 'POLISH_SOURCE_LINK_UNSAFE';
  return error;
}

function polishOutputInvalid() {
  const error = new Error('POLISH_OUTPUT_INVALID: no parseable polish files');
  error.code = 'POLISH_OUTPUT_INVALID';
  return error;
}

function polishEvidenceInvalid(detail) {
  const error = new Error('POLISH_EVIDENCE_INVALID: ' + detail);
  error.code = 'POLISH_EVIDENCE_INVALID';
  return error;
}
