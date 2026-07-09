// Reporter: emits the auditable DELIVERY_REPORT.md for a run.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeReport(ctx, { config, spec, status, rounds, finalReview, shots, scenarioResults, error }) {
  const cmdEvents = ctx.events.filter((e) => e.type === 'cmd:done');
  const fixEvents = ctx.events.filter((e) => e.type === 'fix:applied');

  const lines = [
    `# Delivery Report - ${ctx.runId}`, '',
    `- Status: **${status}**`,
    `- Model: ${config.model} @ ${config.baseUrl}`,
    `- Stack: ${config.stack}`,
    `- Repair rounds used: ${rounds}/${config.maxRepairRounds}`,
    `- Token usage: ${ctx.usage.promptTokens} prompt + ${ctx.usage.completionTokens} completion across ${ctx.usage.calls} calls`,
    '',
    '## Input summary', '',
    (spec?.summary ?? '(planner did not run)'), '',
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
    ...(error ? ['## Fatal error', '', '```', String(error), '```', ''] : []),
    '## Known gaps', '',
    '- Mock data only, no backend.',
    '- Visual similarity to any reference is not scored in MVP.',
    '',
  ];

  const file = path.join(ctx.runDir, 'DELIVERY_REPORT.md');
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  await ctx.logEvent('report:written', { summary: file });
  return file;
}
