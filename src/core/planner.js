// Planner: brief -> structured spec + plan artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';

const SYSTEM = `You are the planner of a bounded app-replication pipeline.
Given a product brief, output STRICT JSON with keys:
  summary: string
  pages: [{ name, route, purpose }]
  components: [{ name, usedBy }]
  dataModel: [{ entity, fields: [string] }]
  interactions: [string]
  acceptance: [string]  // each must be checkable by build/preview/screenshot/page-text
Keep the app small: mock data only, no backend, no auth. Do not invent features beyond the brief.`;

export async function plan(ctx, provider, config) {
  await ctx.logEvent('plan:start', { summary: 'generating spec from brief' });
  const { json: spec, usage } = await provider.chatJson({ system: SYSTEM, user: config.brief });
  ctx.addUsage(usage);

  const specMd = renderSpec(spec);
  const planMd = renderPlan(spec, config);
  await fs.writeFile(path.join(ctx.runDir, 'SPEC.generated.md'), specMd, 'utf8');
  await fs.writeFile(path.join(ctx.runDir, 'PLAN.generated.md'), planMd, 'utf8');
  await ctx.logEvent('plan:done', { summary: `${spec.pages?.length ?? 0} pages planned` });
  return spec;
}

function renderSpec(spec) {
  const lines = [
    '# Generated Spec', '',
    `## Summary`, '', spec.summary ?? '(none)', '',
    '## Pages', '',
    ...(spec.pages ?? []).map((p) => `- **${p.name}** \`${p.route}\` - ${p.purpose}`), '',
    '## Components', '',
    ...(spec.components ?? []).map((c) => `- **${c.name}** (used by: ${c.usedBy})`), '',
    '## Data Model', '',
    ...(spec.dataModel ?? []).map((d) => `- **${d.entity}**: ${(d.fields ?? []).join(', ')}`), '',
    '## Interactions', '',
    ...(spec.interactions ?? []).map((i) => `- ${i}`), '',
    '## Acceptance Criteria', '',
    ...(spec.acceptance ?? []).map((a) => `- [ ] ${a}`), '',
  ];
  return lines.join('\n');
}

function renderPlan(spec, config) {
  return [
    '# Generated Plan', '',
    `- Stack: ${config.stack}`,
    `- Viewport: ${config.viewport.width}x${config.viewport.height}`,
    `- Max repair rounds: ${config.maxRepairRounds}`,
    `- Pages to build: ${(spec.pages ?? []).map((p) => p.name).join(', ')}`,
    '',
    '## Verification plan', '',
    '1. `npm install`',
    '2. `npm run build`',
    '3. start preview server',
    '4. Playwright screenshot per page',
    '5. reviewer checks acceptance criteria against page text + screenshots',
    '',
  ].join('\n');
}
