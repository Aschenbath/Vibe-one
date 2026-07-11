// Reporter: emits the auditable DELIVERY_REPORT.md for a run.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeReport(ctx, {
  config,
  spec,
  status,
  rounds,
  finalReview,
  shots,
  scenarioResults,
  visualHistory = [],
  error,
}) {
  const cmdEvents = ctx.events.filter((e) => e.type === 'cmd:done');
  const fixEvents = ctx.events.filter((e) => e.type === 'fix:applied');

  const lines = [
    `# Delivery Report - ${ctx.runId}`, '',
    `- Status: **${status}**`,
    `- Model: ${config.model}`,
    `- Stack: ${config.stack}`,
    `- Repair rounds used: ${rounds}/${config.maxRepairRounds}`,
    `- Token usage: ${ctx.usage.promptTokens} prompt + ${ctx.usage.completionTokens} completion across ${ctx.usage.calls} calls`,
    '',
    '## Input summary', '',
    (spec?.summary ?? '(planner did not run)'), '',
    '## Input references', '',
    ...((config.references ?? []).length
      ? config.references.map(
        (reference) => `- \`${reference.name}\` (${reference.width}x${reference.height}, ${reference.type})`,
      )
      : ['(none)']),
    '',
    '## Commands executed', '',
    '| step | command | exit | duration |',
    '| --- | --- | --- | --- |',
    ...cmdEvents.map((e) => `| ${e.name} | \`${e.command}\` | ${e.exitCode} | ${e.durationMs}ms |`),
    '',
    '## Repair attempts', '',
    ...(fixEvents.length
      ? fixEvents.flatMap((e) => [`### ${e.summary}`, '', `Diagnosis: ${e.diagnosis ?? '(none)'}`, '', ...(e.files ?? []).map((f) => `- \`${f}\``), ''])
      : ['(none needed)', '']),
    '## Verification checks', '',
    ...(finalReview
      ? finalReview.checks.map((c) => `- [${c.pass ? 'x' : ' '}] ${c.name} (${c.detail})`)
      : ['(verification did not complete)']),
    '',
    '## Interaction scenarios', '',
    ...((scenarioResults ?? []).length
      ? scenarioResults.map((r) => `- [${r.pass ? 'x' : ' '}] ${r.name}${r.error ? ` - ${r.error}` : ''}`)
      : ['(none defined)']),
    '',
    '## Screenshots', '',
    ...((shots ?? []).map((s) => `- ${s.page}: \`screenshots/${path.basename(s.file)}\` (${s.bytes} bytes)`)),
    '',
    '## Visual comparison history', '',
    ...(visualHistory.length
      ? visualHistory.flatMap(({ round, results }) => [
        `### Round ${round}`,
        '',
        ...((results ?? []).length
          ? results.map(
            (result) => `- [${result.pass ? 'x' : ' '}] ${result.page}: ${formatScore(result.score)} / ${formatScore(result.threshold)} (structure ${formatScore(result.structure)}, color ${formatScore(result.color)})`,
          )
          : ['(no mapped references)']),
        '',
      ])
      : ['(no visual comparisons executed)', '']),
    ...(error ? ['## Fatal error', '', `\`${error.code || 'PIPELINE_FAILED'}\``, ''] : []),
    '## Known gaps', '',
    '- Mock data only, no backend.',
    '',
  ];

  const file = path.join(ctx.runDir, 'DELIVERY_REPORT.md');
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  await ctx.logEvent('report:written', { summary: 'DELIVERY_REPORT.md' });
  return file;
}

function formatScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : 'n/a';
}
