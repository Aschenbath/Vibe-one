// Reporter: emits the auditable DELIVERY_REPORT.md for a run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SAFE_POLISH_CAUSES = new Set(['POLISH_FAILED', 'POLISH_ROLLBACK_FAILED']);
const EVIDENCE_BUNDLE_MARKER = '.evidence-bundle.json';
const LABELED_SECRET = /(\b(?:api[\s_-]*key|token|secret|credential|authorization)\b\s*(?:=>|::|:=|=|:)\s*)(?:\x22[^\x22\r\n]*\x22|\x27[^\x27\r\n]*\x27|[^,;}\r\n]+)/gimu;

export async function writeReport(ctx, {
  config,
  spec,
  status,
  rounds,
  finalReview,
  shots,
  scenarioResults,
  visualHistory = [],
  uiQuality = null,
  qualityHistory = [],
  polish = null,
  error,
}, { evidenceFs = fs } = {}) {
  const design = selectDesign(spec);
  const quality = selectQuality(
    qualityHistory,
    uiQuality,
    polish?.candidateEvidence?.uiQuality ? 'polish-quality' : 'quality',
  );
  const polishSummary = selectPolish(polish);
  const lines = renderReport(ctx, {
    config, status, rounds, finalReview, shots, scenarioResults,
    visualHistory, error, design, quality, polish: polishSummary,
  });
  const file = path.join(ctx.runDir, 'DELIVERY_REPORT.md');
  await publishEvidenceBundle(ctx.runDir, [
    { parts: ['DELIVERY_REPORT.md'], content: lines.join('\n') },
    { parts: ['design.json'], content: jsonContent(design) },
    { parts: ['quality', 'summary.json'], content: jsonContent(quality) },
    { parts: ['polish', 'summary.json'], content: jsonContent(polishSummary) },
  ], evidenceFs);
  await ctx.logEvent('report:written', { summary: 'DELIVERY_REPORT.md' });
  return file;
}

function formatScore(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : 'n/a';
}

function selectDesign(spec) {
  if (!spec || typeof spec !== 'object') {
    return { available: false, summary: null, productDesign: null, pages: [], scenarios: [], acceptance: [] };
  }
  const product = spec.productDesign ?? {};
  return {
    available: true,
    summary: safeText(spec.summary, 1000) || null,
    productDesign: {
      productType: safeText(product.productType, 240),
      targetUsers: safeList(product.targetUsers),
      tone: safeText(product.tone, 500),
      density: safeText(product.density, 80),
      navigation: safeSelected(product.navigation),
      contentStrategy: safeSelected(product.contentStrategy),
      tokens: safeSelected(product.tokens),
      componentLanguage: safeList(product.componentLanguage),
      requiredStates: (product.requiredStates ?? []).map((item) => ({
        name: safeText(item?.name, 80),
        trigger: safeText(item?.trigger, 240),
      })),
      responsiveRules: safeList(product.responsiveRules),
    },
    pages: (spec.pages ?? []).map((page) => ({
      name: safeText(page?.name, 160),
      route: safeRoute(page?.route),
      purpose: safeText(page?.purpose, 500),
      mustContain: safeList(page?.mustContain, 240),
      referenceImage: safeImageName(page?.referenceImage),
    })),
    scenarios: (spec.scenarios ?? []).map((scenario) => ({
      name: safeText(scenario?.name, 160),
      route: safeRoute(scenario?.route),
      steps: (scenario?.steps ?? []).map((step) => ({
        action: safeText(step?.action, 40),
        target: safeText(step?.target, 240),
        ...(step?.value !== undefined ? { value: safeText(step.value, 240) } : {}),
      })),
      expectText: safeText(scenario?.expectText, 240),
    })),
    acceptance: safeList(spec.acceptance, 500),
  };
}

function selectQuality(history, terminal, terminalBucket) {
  const rounds = (history ?? []).map(selectQualityRound);
  const terminalEvidence = terminal
    ? { ...selectQualityRound(terminal), bucket: terminalBucket }
    : null;
  return {
    available: rounds.length > 0 || Boolean(terminalEvidence),
    rounds,
    terminal: terminalEvidence,
  };
}

function selectQualityRound(value) {
  const results = (value?.results ?? []).map((result) => ({
    page: safeText(result?.page, 160),
    route: safeRoute(result?.route),
    viewport: ['desktop', 'mobile'].includes(result?.viewport) ? result.viewport : 'unknown',
    pass: result?.pass === true,
    screenshot: safeImageName(result?.screenshot),
  }));
  const failures = (value?.summary?.failures ?? []).map((failure) => ({
    code: safeCode(failure?.code, 'UI_QUALITY_FAILED'),
    page: safeText(failure?.page, 160),
    viewport: ['desktop', 'mobile'].includes(failure?.viewport) ? failure.viewport : 'unknown',
    screenshot: safeImageName(failure?.screenshot),
  }));
  return {
    round: typeof value?.round === 'string' ? safeText(value.round, 40) : finite(value?.round),
    summary: { pass: value?.summary?.pass === true, failureCount: failures.length, failures },
    results,
    evidence: [...new Set(results.map((item) => item.screenshot).filter(Boolean))],
  };
}

function selectPolish(value) {
  const available = Boolean(value?.status && value.status !== 'not-run');
  if (!available) {
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
    draft: selectLineage(value.draftEvidence, value.draftReview),
    candidate: selectLineage(value.candidateEvidence, value.candidateReview),
    failureCauseCode: SAFE_POLISH_CAUSES.has(value.failureCauseCode) ? value.failureCauseCode : null,
    recovery: {
      draftRetained: value.recovery?.draftRetained === true,
      recoveryRequired: value.recovery?.recoveryRequired === true,
    },
  };
}

function selectLineage(evidence, fallbackReview) {
  if (!evidence && !fallbackReview) return null;
  return {
    review: selectReview(evidence?.review ?? fallbackReview),
    evidence: (evidence?.screenshots ?? []).map(safeImageName).filter(Boolean),
  };
}

function selectReview(value) {
  const checks = (value?.checks ?? []).map((check) => ({
    name: safeText(check?.name, 240),
    pass: check?.pass === true,
  }));
  return {
    pass: value?.pass === true,
    checkCount: checks.length,
    failedCount: checks.filter((check) => !check.pass).length,
    checks,
  };
}

function renderReport(ctx, data) {
  const { config, status, rounds, finalReview, shots, scenarioResults, visualHistory, error } = data;
  const review = selectReview(finalReview);
  const safeShots = (shots ?? []).flatMap((shot) => {
    const file = safeImageName(shot?.file);
    return file ? [{ page: safeText(shot?.page, 160), file, bytes: finite(shot?.bytes) }] : [];
  });
  const scenarios = (scenarioResults ?? []).map((item) => ({
    name: safeText(item?.name, 240),
    pass: item?.pass === true,
  }));
  const references = (config.references ?? []).flatMap((item) => {
    const name = safeImageName(item?.name);
    return name ? [{
      name,
      width: finite(item?.width),
      height: finite(item?.height),
      type: ['image/png', 'image/jpeg', 'image/webp'].includes(item?.type) ? item.type : 'unknown',
    }] : [];
  });
  const visual = (visualHistory ?? []).map(({ round, results }) => ({
    round: typeof round === 'string' ? safeText(round, 40) : finite(round),
    results: (results ?? []).map((item) => ({
      page: safeText(item?.page, 160),
      score: finiteScore(item?.score),
      threshold: finiteScore(item?.threshold),
      structure: finiteScore(item?.structure),
      color: finiteScore(item?.color),
      pass: item?.pass === true,
    })),
  }));
  const cmdEvents = ctx.events.filter((item) => item.type === 'cmd:done');
  const fixEvents = ctx.events.filter((item) => item.type === 'fix:applied');
  return [
    `# 交付报告 / Delivery Report - ${safeText(ctx.runId, 160)}`, '',
    '## 概览 / Overview', '',
    `- Status: **${safeText(status, 40) || 'unknown'}**`,
    `- Model: ${safeText(config.model, 120) || 'unknown'}`,
    `- Stack: ${safeText(config.stack, 80) || 'unknown'}`,
    `- Repair rounds used: ${finite(rounds)}/${finite(config.maxRepairRounds)}`,
    `- Pages: ${data.design.pages.length}`,
    `- Scenarios: ${data.design.scenarios.length}`,
    `- Verification checks: ${review.checkCount}`,
    `- Token usage: ${finite(ctx.usage?.promptTokens)} prompt + ${finite(ctx.usage?.completionTokens)} completion across ${finite(ctx.usage?.calls)} calls`,
    '', data.design.summary || '(planner did not run)', '',
    '## 产品设计 / Product Design', '',
    `- Product type: ${data.design.productDesign?.productType || 'n/a'}`,
    `- Tone: ${data.design.productDesign?.tone || 'n/a'}`,
    `- Density: ${data.design.productDesign?.density || 'n/a'}`,
    `- Target users: ${join(data.design.productDesign?.targetUsers)}`,
    `- Required states: ${join((data.design.productDesign?.requiredStates ?? []).map((item) => item.name))}`,
    '',
    ...data.design.pages.flatMap((page) => [
      `### ${page.name || 'Page'} (${page.route})`, '',
      `- Purpose: ${page.purpose || 'n/a'}`,
      `- Required content: ${join(page.mustContain)}`, '',
    ]),
    '## 验收 / Verification', '',
    ...(review.checks.length ? review.checks.map((item) => `- [${item.pass ? 'x' : ' '}] ${item.name}`) : ['(verification did not complete)']),
    '', '### Interaction scenarios', '',
    ...(scenarios.length ? scenarios.map((item) => `- [${item.pass ? 'x' : ' '}] ${item.name}`) : ['(none defined)']),
    '', '### Acceptance criteria', '',
    ...(data.design.acceptance.length ? data.design.acceptance.map((item) => `- ${item}`) : ['(none defined)']), '',
    '## UI 质量验收 / UI Quality Audit', '',
    `- UI audit rounds: ${data.quality.rounds.length}`,
    `- Terminal pass: ${data.quality.terminal?.summary?.pass === true}`,
    `- Terminal failures: ${data.quality.terminal?.summary?.failureCount ?? 0}`, '',
    ...renderQuality(data.quality.rounds),
    '## 视觉比较 / Visual Comparison', '',
    ...renderVisual(visual),
    '## 成品抛光 / Polish', '',
    `- Polish status: ${data.polish.status ?? 'not available'}`,
    `- Changed files: ${data.polish.changedFiles.length}`,
    `- Draft review pass: ${data.polish.draft?.review?.pass ?? 'n/a'}`,
    `- Candidate review pass: ${data.polish.candidate?.review?.pass ?? 'n/a'}`,
    `- Failure cause: ${data.polish.failureCauseCode ?? 'none'}`,
    `- Draft retained: ${data.polish.recovery.draftRetained}`,
    `- Recovery required: ${data.polish.recovery.recoveryRequired}`, '',
    ...(data.polish.changedFiles.length ? data.polish.changedFiles.map((file) => `- \`${file}\``) : ['(no promoted changes)']), '',
    '## 证据 / Evidence', '',
    '### Input references', '',
    ...(references.length ? references.map((item) => `- \`${item.name}\` (${item.width}x${item.height}, ${item.type})`) : ['(none)']), '',
    '### Screenshots', '',
    ...(safeShots.length ? safeShots.map((item) => `- ${item.page}: \`screenshots/${item.file}\` (${item.bytes} bytes)`) : ['(none)']), '',
    '### Commands executed', '',
    '| step | command | exit | duration |', '| --- | --- | --- | --- |',
    ...cmdEvents.map((item) => `| ${safeText(item.name, 80)} | \`${safeText(item.command, 160)}\` | ${finite(item.exitCode)} | ${finite(item.durationMs)}ms |`), '',
    '### Repair attempts', '',
    ...(fixEvents.length ? fixEvents.flatMap((item) => [
      `- ${safeText(item.summary, 160)}`,
      `  - Diagnosis: ${safeText(item.diagnosis, 500) || '(none)'}`,
      ...(item.files ?? []).map(safeRelativeFile).filter(Boolean).map((file) => `  - \`${file}\``),
    ]) : ['(none needed)']), '',
    ...(error ? ['### Fatal error', '', `- \`${safeCode(error.code, 'PIPELINE_FAILED')}\``, ''] : []),
    '## 边界 / Boundaries', '',
    '- 机械 UI 完成度 / Mechanical UI completion checks deterministic build, interaction, viewport, and accessibility rules.',
    '- 粗粒度参考相似度 / Coarse reference similarity is a local structural and color signal, not a guarantee of per-pixel identity.',
    '- 人工视觉检查 / Human visual inspection remains required for hierarchy, polish, and product judgment.',
    '- Mock data only; no backend or production deployment is implied.', '',
  ];
}

function renderQuality(rounds) {
  if (!rounds.length) return ['(no UI audit evidence)', ''];
  return rounds.flatMap((round) => [
    `### UI Round ${round.round}`, '',
    `- Pass: ${round.summary.pass}`,
    `- Failures: ${round.summary.failureCount}`,
    ...round.results.map((item) => `- ${item.viewport} / ${item.page}: ${item.pass ? 'pass' : 'fail'}${item.screenshot ? ` (\`${item.screenshot}\`)` : ''}`), '',
  ]);
}

function renderVisual(history) {
  if (!history.length) return ['(no visual comparisons executed)', ''];
  return history.flatMap(({ round, results }) => [
    `### Round ${round}`, '',
    ...(results.length ? results.map((item) => `- [${item.pass ? 'x' : ' '}] ${item.page}: ${formatScore(item.score)} / ${formatScore(item.threshold)} (structure ${formatScore(item.structure)}, color ${formatScore(item.color)})`) : ['(no mapped references)']), '',
  ]);
}

export function sanitizeEvidenceText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(
      /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*(?:\n\s+at\s+[^\n]*)+/gu,
      '[redacted stack]',
    )
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[redacted-image]')
    .replace(/(?:iVBORw0KGgo|\/9j\/|UklGR)[A-Za-z0-9+/=]{24,}/g, '[redacted-image]')
    .replace(LABELED_SECRET, (match, prefix) => prefix + '[redacted]')
    .replace(/https?:\/\/[^\s`)'\"]+/gi, '[redacted-url]')
    .replace(/\b[A-Za-z]:[\/][^\s`)'\"]+/g, '[redacted-path]')
    .replace(/\\[^\s`)'\"]+/g, '[redacted-path]')
    .replace(/(^|\s)\/(?:Users|home|tmp|private|var|etc|mnt|opt|root)\/[^\s`)'\"]+/g, '$1[redacted-path]')
    .replace(/(^|[^A-Za-z0-9._~-])(?:\/\/|\/)[^\s`)'"]+/g, '$1[redacted-path]')
    .replace(/\s+at\s+[^\s]+:\d+:\d+/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[redacted credential]')
    .replace(/base64/gi, '[redacted-encoding]')
    .slice(0, maxLength)
    .trim();
}

function safeText(value, maxLength = 500) {
  return sanitizeEvidenceText(value, maxLength);
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
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? safeText(name, 160) : null;
}

function safeCode(value, fallback) {
  const code = String(value ?? '');
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function join(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : 'n/a';
}

async function atomicWriteJson(file, value, fsOps = fs) {
  await atomicWrite(file, jsonContent(value), fsOps);
}

function jsonContent(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

async function publishEvidenceBundle(runDir, artifacts, fsOps = fs) {
  const bundleId = randomUUID();
  const stageDir = path.join(runDir, '.evidence-stage-' + bundleId);
  const bundlesDir = path.join(runDir, '.evidence-bundles');
  const bundleDir = path.join(bundlesDir, bundleId);
  const marker = path.join(runDir, EVIDENCE_BUNDLE_MARKER);
  let bundlePublished = false;
  let markerPublished = false;
  try {
    await Promise.all(artifacts.map(({ parts, content }) => (
      atomicWrite(path.join(stageDir, ...parts), content, fsOps)
    )));
    await fsOps.mkdir(bundlesDir, { recursive: true });
    await fsOps.rename(stageDir, bundleDir);
    bundlePublished = true;
    for (const { parts, content } of artifacts) {
      const destination = path.join(runDir, ...parts);
      await atomicWrite(destination, content, fsOps);
    }
    await atomicWriteJson(marker, { version: 1, bundleId }, fsOps);
    markerPublished = true;
  } catch (error) {
    if (bundlePublished && !markerPublished) {
      await fsOps.rm(bundleDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await fsOps.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function atomicWrite(file, content, fsOps = fs) {
  await fsOps.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsOps.writeFile(temporary, content, 'utf8');
    await fsOps.rename(temporary, file);
  } catch (error) {
    await fsOps.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
