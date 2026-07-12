// Fixer: bounded repair loop. Sends compact failure evidence back to the model
// and applies returned file patches. Never exceeds config.maxRepairRounds.
// Uses the same delimiter file protocol as the builder (see builder.js) so large
// patched files never break on JSON escaping.
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parseFileBlocks } from './builder.js';

const DIAG_MARK = '=== DIAGNOSIS ===';
export const UI_EVIDENCE_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
});
const SYSTEM = `You are the fixer of a bounded app-replication pipeline.
You get failing command output, failing review checks, AND the current source of the app.
Fix the ACTUAL cause shown in the source - do not guess. A missing export means either
the export must be added to the module that owns it, or the import must be corrected;
check the current source to decide which.

OUTPUT FORMAT (no JSON, no markdown fences):
${DIAG_MARK}
<one short paragraph: what was wrong and how you fixed it>
=== FILE: relative/path
<FULL corrected file content>
=== END ===
(repeat FILE/END for each file you change)

Rules: return COMPLETE file contents (no diffs), touch as few files as possible, do not add dependencies unless the error proves one is missing.`;

export async function fix(ctx, provider, {
  failure,
  round,
  visualFailures = [],
  uiFailures = [],
}) {
  await ctx.logEvent('fix:start', { summary: `repair round ${round}` });
  const source = await gatherSource(ctx.appDir);
  const user = await createFixerUserContent({
    round,
    failure,
    source,
    visualFailures,
    uiFailures,
  });

  const { content, usage } = await provider.chat({ system: SYSTEM, user });
  ctx.addUsage(usage);

  const diagnosis = extractDiagnosis(content);
  const files = parseFileBlocks(content);
  await applyPatch(ctx, files);
  await ctx.logEvent('fix:applied', {
    summary: `round ${round}: ${files.length} files patched`,
    diagnosis,
    files: files.map((f) => f.path),
  });
  return { diagnosis, files: files.map((f) => f.path) };
}

export async function createFixerUserContent({
  round,
  failure,
  source,
  visualFailures = [],
  uiFailures = [],
}) {
  const text = [
    `Repair round ${round}.`,
    'Failure evidence:',
    failure.slice(0, 12_000), // keep the repair prompt compact
    '',
    'Current app source (authoritative - patch against THIS, do not invent APIs):',
    source,
    '',
    'Return corrected files.',
  ].join('\n');
  if (!visualFailures.length && !uiFailures.length) return text;
  const uiEvidenceFiles = new Set(await validateUiEvidenceFiles(uiFailures));

  const parts = [{
    type: 'text',
    text: [
      `Repair round ${round}.`,
      'Failure evidence:',
      failure.slice(0, 12_000),
      '',
      'Current app source:',
      source,
      '',
      'Fix each verification failure without breaking the build or verified interactions.',
    ].join('\n'),
  }];
  for (const item of visualFailures) {
    parts.push({
      type: 'text',
      text: `${item.page}: score=${item.score}, threshold=${item.threshold}. Reference image follows, then current generated output.`,
    });
    parts.push(await fileImagePart(item.referenceFile, item.referenceType));
    parts.push(await fileImagePart(item.actualFile, 'image/png'));
  }
  const attachedUiScreenshots = new Set();
  for (const item of uiFailures) {
    parts.push({
      type: 'text',
      text: `${formatUiFailure(item)}. Current generated UI screenshot follows.`,
    });
    if (
      item.actualFile
      && uiEvidenceFiles.has(item.actualFile)
      && !attachedUiScreenshots.has(item.actualFile)
    ) {
      attachedUiScreenshots.add(item.actualFile);
      parts.push(await fileImagePart(item.actualFile, 'image/png'));
    }
  }
  return parts;
}

async function fileImagePart(
  file,
  type,
  maxBytes = UI_EVIDENCE_LIMITS.maxFileBytes,
) {
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) {
    const error = new Error('FIXER_IMAGE_TOO_LARGE: repair image exceeds 8 MiB');
    error.code = 'FIXER_IMAGE_TOO_LARGE';
    throw error;
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${type};base64,${bytes.toString('base64')}` },
  };
}

export async function validateUiEvidenceFiles(uiFailures = []) {
  const files = [...new Set(
    uiFailures.map((failure) => failure?.actualFile).filter(Boolean),
  )];
  if (files.length > UI_EVIDENCE_LIMITS.maxFiles) {
    throw uiEvidenceLimit('too many UI screenshots');
  }

  let totalBytes = 0;
  for (const file of files) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      throw uiEvidenceLimit('UI screenshot is unavailable');
    }
    if (!stat.isFile() || stat.size > UI_EVIDENCE_LIMITS.maxFileBytes) {
      throw uiEvidenceLimit('UI screenshot exceeds the per-file limit');
    }
    totalBytes += stat.size;
    if (totalBytes > UI_EVIDENCE_LIMITS.maxTotalBytes) {
      throw uiEvidenceLimit('UI screenshots exceed the aggregate limit');
    }
  }
  return files;
}

function uiEvidenceLimit(detail) {
  const error = new Error(`UI_EVIDENCE_LIMIT: ${detail}`);
  error.code = 'UI_EVIDENCE_LIMIT';
  return error;
}

// Reads the current model-authored source under appDir (skips node_modules,
// the fixed scaffold, and non-text files) so the fixer patches real code, not a
// guess. Bounded so the prompt stays reasonable.
export async function gatherSource(appDir, { maxBytes = 40_000 } = {}) {
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
  const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'vite.config.js']);
  const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.json']);
  const collected = [];
  let total = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= maxBytes) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      const rel = path.relative(appDir, path.join(dir, entry.name)).split(path.sep).join('/');
      if (SKIP_FILES.has(rel) || !TEXT_EXT.has(path.extname(entry.name))) continue;
      try {
        const content = await fs.readFile(path.join(dir, entry.name), 'utf8');
        const block = `=== FILE: ${rel}\n${content}\n=== END ===`;
        total += block.length;
        collected.push(block);
      } catch {
        // unreadable file, skip
      }
    }
  }

  await walk(appDir);
  const joined = collected.join('\n');
  return joined.length > maxBytes ? joined.slice(0, maxBytes) + '\n... (source truncated)' : joined;
}

// Pulls the diagnosis paragraph that precedes the first FILE block.
function extractDiagnosis(text) {
  const afterMark = text.split(DIAG_MARK)[1] ?? text;
  const beforeFirstFile = afterMark.split('=== FILE:')[0] ?? '';
  return beforeFirstFile.replace(/```/g, '').trim().slice(0, 500) || '(none)';
}

// Renders failure evidence for the model from runner/reviewer results.
export function describeFailure({
  install,
  build,
  shots,
  scenarioResults,
  reviewResult,
  uiQuality,
  previewError,
}) {
  const parts = [];
  if (previewError) parts.push(`PREVIEW FAILED:\n${previewError}`);
  if (install && install.exitCode !== 0) {
    parts.push(`NPM INSTALL FAILED (exit ${install.exitCode}):\n${tail(install.stderr || install.stdout)}`);
  }
  if (build && build.exitCode !== 0) {
    parts.push(`BUILD FAILED (exit ${build.exitCode}):\n${tail(build.stderr || build.stdout)}`);
  }
  if (reviewResult?.failed?.length) {
    parts.push(
      'REVIEW CHECKS FAILED:\n' +
        reviewResult.failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n'),
    );
  }
  const uiSummary = uiQuality?.summary ?? uiQuality ?? reviewResult?.uiQuality;
  if (uiSummary?.failures?.length) {
    parts.push(
      'UI QUALITY AUDIT FAILED:\n'
        + uiSummary.failures.map(formatUiFailure).join('\n'),
    );
  }
  if (scenarioResults?.some((r) => !r.pass)) {
    parts.push(
      'INTERACTION SCENARIOS FAILED:\n' +
        scenarioResults
          .filter((r) => !r.pass)
          .map((r) => `- ${r.name}: ${r.error ?? 'failed'}`)
          .join('\n'),
    );
  }
  if (shots?.length) {
    parts.push(
      'PAGE TEXT SAMPLES:\n' +
        shots.map((s) => `--- ${s.page} (${s.route}) ---\n${(s.text ?? '').slice(0, 500)}`).join('\n'),
    );
  }
  return parts.join('\n\n') || 'unknown failure';
}

function tail(text, n = 4000) {
  return String(text ?? '').slice(-n);
}

function formatUiFailure(failure) {
  const safe = sanitizeUiFailure(failure);
  return [
    `- ${safe.code || 'UI_QUALITY_FAILED'}`,
    `page=${safe.page || 'unknown'}`,
    `route=${safe.route || 'unknown'}`,
    `viewport=${safe.viewport || 'unknown'}`,
    `detail=${safe.detail || 'failed'}`,
    `screenshot=${safe.screenshot || 'unavailable'}`,
  ].join(' | ');
}

export function sanitizeUiFailure(failure) {
  return {
    code: safeEvidenceText(failure?.code, 80),
    page: safeEvidenceText(failure?.page, 120),
    route: safeEvidenceText(failure?.route, 160),
    viewport: safeEvidenceText(failure?.viewport, 40),
    detail: safeEvidenceText(failure?.detail, 500),
    screenshot: safeScreenshotName(failure?.screenshot),
  };
}

function safeScreenshotName(value) {
  const filename = path.posix.basename(path.win32.basename(String(value ?? '')));
  return safeEvidenceText(filename, 160);
}

function safeEvidenceText(value, maxLength) {
  return String(value ?? '')
    .replace(
      /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*(?:\n\s+at\s+[^\n]*)+/gu,
      '[redacted stack]',
    )
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/giu, '[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '[redacted]')
    .replace(/(^|\s)\/(?:[^/\s]+\/)+[^\s]+/gu, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
