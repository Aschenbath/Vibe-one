// Fixer: bounded repair loop. Sends compact failure evidence back to the model
// and applies returned file patches. Never exceeds config.maxRepairRounds.
// Uses the same delimiter file protocol as the builder (see builder.js) so large
// patched files never break on JSON escaping.
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parseFileBlocks } from './builder.js';

const DIAG_MARK = '=== DIAGNOSIS ===';
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

export async function fix(ctx, provider, { failure, round }) {
  await ctx.logEvent('fix:start', { summary: `repair round ${round}` });
  const source = await gatherSource(ctx.appDir);
  const user = [
    `Repair round ${round}.`,
    'Failure evidence:',
    failure.slice(0, 12_000), // keep the repair prompt compact
    '',
    'Current app source (authoritative - patch against THIS, do not invent APIs):',
    source,
    '',
    'Return corrected files.',
  ].join('\n');

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
export function describeFailure({ install, build, shots, scenarioResults, reviewResult, previewError }) {
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
