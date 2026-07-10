// Pipeline orchestrator: plan -> build -> verify -> (repair loop) -> report.
// Never claims success unless the reviewer passes. Bounded by maxRepairRounds.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRunContext } from './runContext.js';
import { createProvider } from '../providers/openaiCompatible.js';
import { plan } from './planner.js';
import { build } from './builder.js';
import { review } from './reviewer.js';
import { fix, describeFailure } from './fixer.js';
import {
  npmInstall,
  npmBuild,
  startPreview,
  screenshotPages,
  runScenarios,
  compareReferencePages,
} from '../runner/commands.js';
import { writeReport } from '../reporter/deliveryReport.js';

export async function runPipeline({ targetDir, config, planOnly = false, provider: injectedProvider }) {
  const ctx = await createRunContext(targetDir, config);
  const provider = injectedProvider ?? createProvider(config);

  let spec = null;
  let status = 'failed';
  let rounds = 0;
  let finalReview = null;
  let shots = [];
  let scenarioResults = [];
  let visualResults = [];
  const visualHistory = [];
  let fatal = null;

  try {
    spec = await plan(ctx, provider, config);
    if (planOnly) {
      status = 'planned';
      return finish();
    }

    await build(ctx, provider, config, spec);

    // verify + bounded repair
    for (rounds = 0; rounds <= config.maxRepairRounds; rounds++) {
      const verdict = await verifyOnce(ctx, config, spec);
      finalReview = verdict.reviewResult;
      shots = verdict.shots;
      scenarioResults = verdict.scenarioResults ?? [];
      visualResults = verdict.visualResults ?? [];
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
      await fix(ctx, provider, {
        failure,
        round: rounds + 1,
        visualFailures,
      });
    }
  } catch (err) {
    fatal = err;
    await ctx.logEvent('fatal', {
      summary: err.message,
      ...(err.code ? { code: String(err.code) } : {}),
    });
  }

  return finish();

  async function finish() {
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
      error: fatal,
    });
    return { runId: ctx.runId, runDir: ctx.runDir, status };
  }
}

// One full verification pass: install -> build -> preview -> screenshots -> review.
async function verifyOnce(ctx, config, spec) {
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
  try {
    shots = await screenshotPages(ctx, preview.url, spec.pages ?? [], config.viewport);
    scenarioResults = await runScenarios(ctx, preview.url, spec.scenarios ?? [], config.viewport);
    visualResults = await compareReferencePages(
      ctx,
      preview.url,
      spec.pages ?? [],
      config.references ?? [],
      config.visualThreshold,
    );
  } catch (err) {
    return {
      install,
      build: buildResult,
      shots,
      scenarioResults,
      visualResults,
      reviewResult: failEarly(`screenshot/scenario/visual failed: ${err.message}`),
    };
  } finally {
    preview.stop();
  }

  const reviewResult = review({
    install,
    build: buildResult,
    shots,
    spec,
    scenarioResults,
    visualResults,
  });
  await ctx.logEvent('review', {
    summary: reviewResult.pass ? 'all checks pass' : `${reviewResult.failed.length} checks failing`,
  });
  return { install, build: buildResult, shots, scenarioResults, visualResults, reviewResult };
}

function failEarly(reason) {
  const check = { name: reason, pass: false, detail: 'pipeline stage failed before review' };
  return { pass: false, checks: [check], failed: [check] };
}
