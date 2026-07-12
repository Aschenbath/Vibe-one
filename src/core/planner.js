// Planner: brief -> structured spec + plan artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderProductDesign, validateProductDesign } from './productDesign.js';
import { referenceContentPart } from './referenceImages.js';

export const PLANNER_SYSTEM = `You are the planner of a bounded app-replication pipeline.
Given a product brief, output STRICT JSON with keys:
  summary: string
  visualDesign: { layout: string, palette: [string], typography: string, spacing: string, components: [string], responsive: string }
  productDesign: {
    productType: string
    targetUsers: [string]
    tone: string
    density: string
    navigation: string
    contentStrategy: string
    tokens: { colors: object, typography: object, spacing: [string], radii: [string] }
    componentLanguage: [string]
    requiredStates: [{ name, trigger }]
    responsiveRules: [string]
  }
  pages: [{ name, route, purpose, mustContain: [string], referenceImage: string|null }]
      // mustContain: 2-4 short visible text fragments that MUST appear on that page (labels, headings, seeded values)
      // referenceImage: exact uploaded reference file name mapped to this page, or null when no image applies
  components: [{ name, usedBy }]
  dataModel: [{ entity, fields: [string] }]
  interactions: [string]
  acceptance: [string]  // human-readable acceptance criteria
  scenarios: [{ name, route, steps: [{ action, target, value }], expectText }]
      // action is "click" or "fill"; target is user-visible button/link text or an input placeholder/label;
      // value is required for fill; expectText is a visible string that must appear AFTER the steps run.
      // Encode each testable interaction from the brief as one scenario (e.g. add item -> new row visible, search -> filtered).
Keep the app small: mock data only, no backend, no auth. Do not invent features beyond the brief.
Make productDesign values executable and product-specific, not generic phrases such as modern or clean.
Provide at least 6 color tokens, 4 typography tokens, 5 spacing values, and 3 radii.
requiredStates must contain at least 2 distinct states named loading, empty, error, or success; each trigger must be concrete and at least 4 characters.
Core productDesign text must be concrete; density may be compact, otherwise describe it with at least 8 characters.
Every mustContain fragment and every scenario.expectText must be something a correct implementation of THIS brief will actually render.`;

export function createPlannerUserContent(config) {
  const references = config.references ?? [];
  if (!references.length) return config.brief;
  const text = [
    'Product brief:',
    config.brief || '(no text brief; infer the product from the reference images)',
    '',
    'Reference images:',
    ...references.map(
      (reference, index) => `${index + 1}. ${reference.name} (${reference.width}x${reference.height}, ${reference.type})`,
    ),
    '',
    'Map each image to the closest planned page using pages[].referenceImage. Use null when a page has no reference.',
  ].join('\n');
  return [{ type: 'text', text }, ...references.map(referenceContentPart)];
}

export async function plan(ctx, provider, config) {
  await ctx.logEvent('plan:start', { summary: 'generating spec from brief' });
  const { json: spec, usage } = await provider.chatJson({
    system: PLANNER_SYSTEM,
    user: createPlannerUserContent(config),
  });
  ctx.addUsage(usage);
  validateVisualPlan(spec, config.references ?? []);
  spec.productDesign = validateProductDesign(spec?.productDesign);

  const specMd = renderSpec(spec);
  const planMd = renderPlan(spec, config);
  await fs.writeFile(path.join(ctx.runDir, 'SPEC.generated.md'), specMd, 'utf8');
  await fs.writeFile(path.join(ctx.runDir, 'PLAN.generated.md'), planMd, 'utf8');
  await ctx.logEvent('design:done', {
    summary: String(spec.pages?.length ?? 0) + ' pages with executable product design',
  });
  await ctx.logEvent('plan:done', {
    summary: `${spec.pages?.length ?? 0} pages, ${spec.scenarios?.length ?? 0} scenarios planned`,
  });
  return spec;
}

function validateVisualPlan(spec, references) {
  if (!references.length) return;
  const visualDesign = spec?.visualDesign;
  const stringFields = ['layout', 'typography', 'spacing', 'responsive'];
  const listFields = ['palette', 'components'];
  if (
    !visualDesign
    || stringFields.some((field) => typeof visualDesign[field] !== 'string' || !visualDesign[field].trim())
    || listFields.some(
      (field) => !Array.isArray(visualDesign[field])
        || visualDesign[field].length === 0
        || visualDesign[field].some((value) => typeof value !== 'string' || !value.trim()),
    )
  ) {
    throw coded('VISUAL_PLAN_INVALID', 'planner returned an incomplete visualDesign');
  }

  const allowed = new Set(references.map((reference) => reference.name));
  const mapped = new Set();
  for (const page of spec.pages ?? []) {
    if (page.referenceImage == null) continue;
    if (!allowed.has(page.referenceImage)) {
      throw coded('VISUAL_PLAN_INVALID', `planner mapped an unknown reference: ${page.referenceImage}`);
    }
    mapped.add(page.referenceImage);
  }
  const missing = [...allowed].filter((name) => !mapped.has(name));
  if (missing.length) {
    throw coded('VISUAL_PLAN_INVALID', `planner did not map references: ${missing.join(', ')}`);
  }
}

function coded(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function renderSpec(spec) {
  const lines = [
    '# 生成规格 / Generated Spec', '',
    '## 概要 / Summary', '', spec.summary ?? '(none)', '',
    '## 视觉设计 / Visual Design', '',
    `- Layout: ${spec.visualDesign?.layout ?? '(not specified)'}`,
    `- Palette: ${(spec.visualDesign?.palette ?? []).join(', ') || '(not specified)'}`,
    `- Typography: ${spec.visualDesign?.typography ?? '(not specified)'}`,
    `- Spacing: ${spec.visualDesign?.spacing ?? '(not specified)'}`,
    `- Components: ${(spec.visualDesign?.components ?? []).join(', ') || '(not specified)'}`,
    `- Responsive: ${spec.visualDesign?.responsive ?? '(not specified)'}`, '',
    renderProductDesign(spec.productDesign), '',
    '## 页面 / Pages', '',
    ...(spec.pages ?? []).flatMap((p) => [
      `- **${p.name}** \`${p.route}\` - ${p.purpose}`,
      `  - reference image: ${p.referenceImage ? `\`${p.referenceImage}\`` : '(none)'}`,
      ...(p.mustContain ?? []).map((t) => `  - must contain: \`${t}\``),
    ]), '',
    '## 组件 / Components', '',
    ...(spec.components ?? []).map((c) => `- **${c.name}** (used by: ${c.usedBy})`), '',
    '## 数据模型 / Data Model', '',
    ...(spec.dataModel ?? []).map((d) => `- **${d.entity}**: ${(d.fields ?? []).join(', ')}`), '',
    '## 交互 / Interactions', '',
    ...(spec.interactions ?? []).map((i) => `- ${i}`), '',
    '## 交互场景（已验证） / Interaction Scenarios (verified)', '',
    ...(spec.scenarios ?? []).map(
      (s) => `- **${s.name}** (\`${s.route}\`): ${(s.steps ?? []).map((st) => `${st.action} "${st.target}"${st.value ? `="${st.value}"` : ''}`).join(' -> ')} => expect \`${s.expectText}\``,
    ), '',
    '## 验收标准 / Acceptance Criteria', '',
    ...(spec.acceptance ?? []).map((a) => `- [ ] ${a}`), '',
  ];
  return lines.join('\n');
}

function renderPlan(spec, config) {
  return [
    '# 生成计划 / Generated Plan', '',
    '- 产品概要 / Product Summary: ' + (spec.summary ?? '(none)'),
    `- Stack: ${config.stack}`,
    `- Viewport: ${config.viewport.width}x${config.viewport.height}`,
    `- Max repair rounds: ${config.maxRepairRounds}`,
    `- Pages to build: ${(spec.pages ?? []).map((p) => p.name).join(', ')}`,
    `- Reference images: ${(config.references ?? []).map((reference) => reference.name).join(', ') || '(none)'}`,
    `- Visual direction: ${spec.visualDesign?.layout ?? '(not specified)'}; ${(spec.visualDesign?.palette ?? []).join(', ') || '(no palette)'}`,
    '- 产品设计 / Product design: '
      + spec.productDesign.productType
      + '; '
      + spec.productDesign.tone
      + '; '
      + spec.productDesign.density,
    '',
    '## 参考图映射 / Reference Mapping', '',
    ...(spec.pages ?? []).map(
      (page) => `- **${page.name}**: ${page.referenceImage ? `\`${page.referenceImage}\`` : '(none)'}`,
    ), '',
    '## 验证计划 / Verification Plan', '',
    '1. `npm install --ignore-scripts`',
    '2. `npm run build`',
    '3. start preview server on a free port',
    '4. Playwright screenshot per page + assert mustContain text',
    '5. run interaction scenarios and assert expectText',
    '',
  ].join('\n');
}
