// Pipeline orchestrator: plan -> build -> verify -> (repair loop) -> report.
// Never claims success unless the reviewer passes. Bounded by maxRepairRounds.
import { createRunContext } from './runContext.js';
import { createProvider } from '../providers/openaiCompatible.js';
import { plan } from './planner.js';
import { build } from './builder.js';
import { review } from './reviewer.js';
import { fix, describeFailure } from './fixer.js';
import { npmInstall, npmBuild, startPreview, screenshotPages } from '../runner/commands.js';
import { writeReport } from '../reporter/deliveryReport.js';

export async function runPipeline({ targetDir, config, planOnly = false }) {
  const ctx = await createRunContext(targetDir);
  const provider = createProvider(config);

  let spec = null;
  let status = 'failed';
  let rounds = 0;
  let finalReview = null;
  let shots = [];
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

      if (verdict.reviewResult?.pass) {
        status = 'success';
        break;
      }
      if (rounds === config.maxRepairRounds) {
        await ctx.logEvent('repair:exhausted', { summary: `still failing after ${rounds} repair rounds` });
        break;
      }
      const failure = describeFailure(verdict);
      await fix(ctx, provider, { failure, round: rounds + 1 });
    }
  } catch (err) {
    fatal = err;
    await ctx.logEvent('fatal', { summary: err.message });
  }

  return finish();

  async function finish() {
    await writeReport(ctx, { config, spec, status, rounds, finalReview, shots, error: fatal });
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
  try {
    shots = await screenshotPages(ctx, preview.url, spec.pages ?? [], config.viewport);
  } catch (err) {
    return { install, build: buildResult, shots, reviewResult: failEarly(`screenshot failed: ${err.message}`) };
  } finally {
    preview.stop();
  }

  const reviewResult = review({ install, build: buildResult, shots, spec });
  await ctx.logEvent('review', {
    summary: reviewResult.pass ? 'all checks pass' : `${reviewResult.failed.length} checks failing`,
  });
  return { install, build: buildResult, shots, reviewResult };
}

function failEarly(reason) {
  const check = { name: reason, pass: false, detail: 'pipeline stage failed before review' };
  return { pass: false, checks: [check], failed: [check] };
}
