// Pipeline orchestrator: plan -> build -> verify -> (repair loop) -> report.
// Never claims success unless the reviewer passes. Bounded by maxRepairRounds.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRunContext } from './runContext.js';
import { createProvider } from '../providers/openaiCompatible.js';
import { plan } from './planner.js';
import { build } from './builder.js';
import { review } from './reviewer.js';
import { fix, describeFailure, sanitizeUiFailure } from './fixer.js';
import {
  npmInstall,
  npmBuild,
  startPreview,
  screenshotPages,
  runScenarios,
  collectUiQuality,
  compareReferencePages,
} from '../runner/commands.js';
import { writeReport } from '../reporter/deliveryReport.js';

export async function runPipeline({
  targetDir,
  config,
  planOnly = false,
  provider: injectedProvider,
  uiCollector = collectUiQuality,
}) {
  const ctx = await createRunContext(targetDir, config);
  const provider = injectedProvider ?? createProvider(config);

  let spec = null;
  let status = 'failed';
  let rounds = 0;
  let finalReview = null;
  let shots = [];
  let scenarioResults = [];
  let visualResults = [];
  let uiQuality = null;
  const visualHistory = [];
  const qualityHistory = [];
  let fatal = null;
  let errorCode;
  const qualityDir = ctx.qualityDir ?? path.join(ctx.runDir, 'quality');
  await fs.mkdir(qualityDir, { recursive: true });

  try {
    spec = await plan(ctx, provider, config);
    if (planOnly) {
      status = 'planned';
      return finish();
    }

    await build(ctx, provider, config, spec);

    // verify + bounded repair
    for (rounds = 0; rounds <= config.maxRepairRounds; rounds++) {
      const verdict = await verifyOnce(
        ctx,
        config,
        spec,
        rounds,
        uiCollector,
        qualityDir,
      );
      finalReview = verdict.reviewResult;
      shots = verdict.shots;
      scenarioResults = verdict.scenarioResults ?? [];
      visualResults = verdict.visualResults ?? [];
      uiQuality = verdict.uiQuality ?? uiQuality;
      if (verdict.uiQuality) {
        qualityHistory.push({ round: rounds, ...verdict.uiQuality });
        await fs.writeFile(
          path.join(qualityDir, `round-${rounds}.json`),
          JSON.stringify(verdict.uiQuality, null, 2),
          'utf8',
        );
        await fs.writeFile(
          path.join(qualityDir, 'history.json'),
          JSON.stringify(qualityHistory, null, 2),
          'utf8',
        );
      }
      visualHistory.push({ round: rounds, results: visualResults });
      await fs.writeFile(
        path.join(ctx.visualDir, `round-${rounds}.json`),
        JSON.stringify(visualResults, null, 2),
        'utf8',
      );
      await fs.writeFile(
        path.join(ctx.visualDir, 'comparisons.json'),
        JSON.stringify(visualHistory, null, 2),
        'utf8',
      );

      if (verdict.reviewResult?.pass) {
        status = 'success';
        break;
      }
      if (rounds === config.maxRepairRounds) {
        await ctx.logEvent('repair:exhausted', { summary: `still failing after ${rounds} repair rounds` });
        break;
      }
      const failure = describeFailure(verdict);
      const visualFailures = visualResults
        .filter((result) => !result.pass && result.actualImage)
        .map((result) => {
          const reference = (config.references ?? []).find(
            (item) => item.name === result.referenceImage,
          );
          if (!reference) return null;
          return {
            ...result,
            referenceFile: path.join(ctx.referencesDir, reference.name),
            actualFile: path.join(ctx.screenshotsDir, result.actualImage),
            referenceType: reference.type,
          };
        })
        .filter(Boolean);
      const uiFailures = await buildUiFailures(
        qualityDir,
        verdict.uiQuality?.summary?.failures ?? [],
      );
      await fix(ctx, provider, {
        failure,
        round: rounds + 1,
        visualFailures,
        uiFailures,
      });
    }
  } catch (err) {
    fatal = err;
    await ctx.logEvent('fatal', {
      summary: err.code ? String(err.code) : 'PIPELINE_FAILED',
      ...(err.code ? { code: String(err.code) } : {}),
    });
  }

  return finish();

  async function finish() {
    const uiFailed = finalReview?.uiQuality?.pass === false;
    errorCode = fatal
      ? String(fatal.code || 'PIPELINE_FAILED')
      : uiFailed ? 'UI_QUALITY_FAILED' : undefined;
    await fs.writeFile(
      path.join(qualityDir, 'history.json'),
      JSON.stringify(qualityHistory, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(ctx.visualDir, 'comparisons.json'),
      JSON.stringify(visualHistory, null, 2),
      'utf8',
    );
    await writeReport(ctx, {
      config,
      spec,
      status,
      rounds,
      finalReview,
      shots,
      scenarioResults,
      visualHistory,
      uiQuality,
      qualityHistory,
      errorCode,
      error: fatal,
    });
    return {
      runId: ctx.runId,
      runDir: ctx.runDir,
      status,
      uiQuality,
      qualityHistory,
      ...(errorCode ? { errorCode } : {}),
    };
  }
}

// One full verification pass: install -> build -> preview -> screenshots -> review.
async function verifyOnce(ctx, config, spec, round, uiCollector, qualityDir) {
  const install = await npmInstall(ctx);
  if (install.exitCode !== 0) {
    return { install, build: null, shots: [], reviewResult: failEarly('npm install failed') };
  }
  const buildResult = await npmBuild(ctx);
  if (buildResult.exitCode !== 0) {
    return { install, build: buildResult, shots: [], reviewResult: failEarly('npm run build failed') };
  }

  let preview;
  try {
    preview = await startPreview(ctx);
  } catch (err) {
    return { install, build: buildResult, shots: [], reviewResult: failEarly('preview failed'), previewError: err.message };
  }

  let shots = [];
  let scenarioResults = [];
  let visualResults = [];
  let uiQuality = null;
  try {
  try {
    shots = await screenshotPages(ctx, preview.url, spec.pages ?? [], config.viewport);
    scenarioResults = await runScenarios(ctx, preview.url, spec.scenarios ?? [], config.viewport);
  } catch {
    return {
      install,
      build: buildResult,
      shots,
      scenarioResults,
      visualResults,
      uiQuality,
      reviewResult: failEarly('screenshot/scenario failed'),
    };
  }

  const collectedUiQuality = await uiCollector(
    ctx,
    preview.url,
    spec.pages ?? [],
    spec.productDesign?.requiredStates ?? [],
  );
  await qualifyUiScreenshots(qualityDir, collectedUiQuality, round);
  uiQuality = safeUiQualityEvidence(collectedUiQuality);
  await ctx.logEvent('quality:audit', {
    summary: uiQuality.summary.pass
      ? 'UI quality checks pass'
      : `${uiQuality.summary.failures.length} checks failing`,
    ...(!uiQuality.summary.pass ? { code: 'UI_QUALITY_FAILED' } : {}),
  });

  try {
    visualResults = await compareReferencePages(
      ctx,
      preview.url,
      spec.pages ?? [],
      config.references ?? [],
      config.visualThreshold,
      round,
    );
  } catch {
    return {
      install,
      build: buildResult,
      shots,
      scenarioResults,
      visualResults,
      uiQuality,
      reviewResult: failEarly('visual comparison failed'),
    };
  }

  const reviewResult = review({
    install,
    build: buildResult,
    shots,
    spec,
    scenarioResults,
    visualResults,
    uiQuality: uiQuality.summary,
  });
  await ctx.logEvent('review', {
    summary: reviewResult.pass ? 'all checks pass' : `${reviewResult.failed.length} checks failing`,
  });
  return {
    install,
    build: buildResult,
    shots,
    scenarioResults,
    visualResults,
    uiQuality,
    reviewResult,
  };
  } finally {
    preview.stop();
  }
}

function failEarly(reason) {
  const check = { name: reason, pass: false, detail: 'pipeline stage failed before review' };
  return { pass: false, checks: [check], failed: [check] };
}

function safeUiQualityEvidence(value = {}) {
  const results = (value.results ?? []).map((result) => {
    const identity = sanitizeUiFailure(result);
    const failures = (result.failures ?? []).map(sanitizeUiFailure);
    return {
      page: identity.page,
      route: identity.route,
      viewport: identity.viewport,
      pass: result.pass === true && failures.length === 0,
      failures,
      metrics: {
        scrollWidth: finiteNumber(result.metrics?.scrollWidth),
        clientWidth: finiteNumber(result.metrics?.clientWidth),
        interactiveCount: finiteNumber(result.metrics?.interactiveCount),
        textSampleCount: finiteNumber(result.metrics?.textSampleCount),
        screenshotBytes: finiteNumber(result.metrics?.screenshotBytes),
      },
      screenshot: identity.screenshot,
    };
  });
  const failures = (value.summary?.failures ?? []).map((failure) => {
    const matchingResult = (value.results ?? []).find(
      (result) => (
        result.page === failure.page
        && result.viewport === failure.viewport
      ),
    );
    return sanitizeUiFailure({
      ...failure,
      screenshot: failure.screenshot ?? matchingResult?.screenshot,
    });
  });
  return {
    results,
    summary: {
      pass: value.summary?.pass === true && failures.length === 0,
      failures,
    },
  };
}

async function buildUiFailures(qualityDir, failures) {
  const items = [];
  for (const failure of failures) {
    const safe = sanitizeUiFailure(failure);
    if (!safe.screenshot) continue;
    const actualFile = path.join(qualityDir, safe.screenshot);
    try {
      const stat = await fs.stat(actualFile);
      if (stat.isFile() && stat.size > 0) items.push({ ...safe, actualFile });
    } catch {
      // Missing screenshots remain structured text evidence only.
    }
  }
  return items;
}

async function qualifyUiScreenshots(qualityDir, uiQuality, round) {
  const renamed = new Map();
  for (const result of uiQuality?.results ?? []) {
    const sourceName = path.posix.basename(
      path.win32.basename(String(result.screenshot ?? '')),
    );
    if (!sourceName) continue;
    if (!renamed.has(sourceName)) {
      const targetName = await availableRoundScreenshotName(
        qualityDir,
        sourceName,
        round,
      );
      await fs.rename(
        path.join(qualityDir, sourceName),
        path.join(qualityDir, targetName),
      );
      renamed.set(sourceName, targetName);
    }
    result.screenshot = renamed.get(sourceName);
  }
}

async function availableRoundScreenshotName(qualityDir, sourceName, round) {
  const extension = path.extname(sourceName) || '.png';
  const stem = path.basename(sourceName, extension);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${stem}-round-${round}${suffix === 1 ? '' : `-${suffix}`}${extension}`;
    try {
      await fs.access(path.join(qualityDir, candidate));
    } catch {
      return candidate;
    }
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
