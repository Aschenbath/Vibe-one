// Planner: brief -> structured spec + plan artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';

const SYSTEM = `You are the planner of a bounded app-replication pipeline.
Given a product brief, output STRICT JSON with keys:
  summary: string
  pages: [{ name, route, purpose, mustContain: [string] }]
      // mustContain: 2-4 short visible text fragments that MUST appear on that page (labels, headings, seeded values)
  components: [{ name, usedBy }]
  dataModel: [{ entity, fields: [string] }]
  interactions: [string]
  acceptance: [string]  // human-readable acceptance criteria
  scenarios: [{ name, route, steps: [{ action, target, value }], expectText }]
      // action is "click" or "fill"; target is user-visible button/link text or an input placeholder/label;
      // value is required for fill; expectText is a visible string that must appear AFTER the steps run.
      // Encode each testable interaction from the brief as one scenario (e.g. add item -> new row visible, search -> filtered).
Keep the app small: mock data only, no backend, no auth. Do not invent features beyond the brief.
Every mustContain fragment and every scenario.expectText must be something a correct implementation of THIS brief will actually render.`;

export async function plan(ctx, provider, config) {
  await ctx.logEvent('plan:start', { summary: 'generating spec from brief' });
  const { json: spec, usage } = await provider.chatJson({ system: SYSTEM, user: config.brief });
  ctx.addUsage(usage);

  const specMd = renderSpec(spec);
  const planMd = renderPlan(spec, config);
  await fs.writeFile(path.join(ctx.runDir, 'SPEC.generated.md'), specMd, 'utf8');
  await fs.writeFile(path.join(ctx.runDir, 'PLAN.generated.md'), planMd, 'utf8');
  await ctx.logEvent('plan:done', {
    summary: `${spec.pages?.length ?? 0} pages, ${spec.scenarios?.length ?? 0} scenarios planned`,
  });
  return spec;
}

function renderSpec(spec) {
  const lines = [
    '# Generated Spec', '',
    `## Summary`, '', spec.summary ?? '(none)', '',
    '## Pages', '',
    ...(spec.pages ?? []).flatMap((p) => [
      `- **${p.name}** \`${p.route}\` - ${p.purpose}`,
      ...(p.mustContain ?? []).map((t) => `  - must contain: \`${t}\``),
    ]), '',
    '## Components', '',
    ...(spec.components ?? []).map((c) => `- **${c.name}** (used by: ${c.usedBy})`), '',
    '## Data Model', '',
    ...(spec.dataModel ?? []).map((d) => `- **${d.entity}**: ${(d.fields ?? []).join(', ')}`), '',
    '## Interactions', '',
    ...(spec.interactions ?? []).map((i) => `- ${i}`), '',
    '## Interaction Scenarios (verified)', '',
    ...(spec.scenarios ?? []).map(
      (s) => `- **${s.name}** (\`${s.route}\`): ${(s.steps ?? []).map((st) => `${st.action} "${st.target}"${st.value ? `="${st.value}"` : ''}`).join(' -> ')} => expect \`${s.expectText}\``,
    ), '',
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
    '1. `npm install --ignore-scripts`',
    '2. `npm run build`',
    '3. start preview server on a free port',
    '4. Playwright screenshot per page + assert mustContain text',
    '5. run interaction scenarios and assert expectText',
    '',
  ].join('\n');
}
