// Fixer: bounded repair loop. Sends compact failure evidence back to the model
// and applies returned file patches. Never exceeds config.maxRepairRounds.
// Uses the same delimiter file protocol as the builder (see builder.js) so large
// patched files never break on JSON escaping.
import { applyPatch, parseFileBlocks } from './builder.js';

const DIAG_MARK = '=== DIAGNOSIS ===';
const SYSTEM = `You are the fixer of a bounded app-replication pipeline.
You get failing command output and failing review checks for a React+Vite app.

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
  const user = [
    `Repair round ${round}.`,
    'Failure evidence:',
    failure.slice(0, 12_000), // keep the repair prompt compact
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
