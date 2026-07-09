#!/usr/bin/env node
// Vibe-one CLI entry.
// Usage:
//   node src/cli/index.js run <target-dir>   Run the full pipeline on a target (dir containing input/)
//   node src/cli/index.js plan <target-dir>  Planner only: generate SPEC/PLAN without building
import { runPipeline } from '../core/pipeline.js';
import { loadConfig } from '../core/config.js';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`vibe-one - bounded AI delivery pipeline

Commands:
  run <target-dir>    Full pipeline: plan -> build -> verify -> repair -> report
  plan <target-dir>   Planner only (writes SPEC.generated.md / PLAN.generated.md)

Environment:
  VIBE_ONE_API_KEY    API key for the OpenAI-compatible endpoint (required)
  VIBE_ONE_BASE_URL   Base URL, default https://api.openai.com/v1
  VIBE_ONE_MODEL      Model id, default gpt-4o-mini (overridable in constraints.json)
`);
}

async function main() {
  const [cmd, targetArg] = process.argv.slice(2);
  if (!cmd || !targetArg || !['run', 'plan'].includes(cmd)) {
    usage();
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  const targetDir = path.resolve(process.cwd(), targetArg);
  const config = await loadConfig(targetDir);
  const result = await runPipeline({ targetDir, config, planOnly: cmd === 'plan' });
  console.log(`\nRun ${result.runId} finished: ${result.status}`);
  console.log(`Artifacts: ${result.runDir}`);
  if (result.status !== 'success') process.exitCode = 2;
}

main().catch((err) => {
  console.error('[vibe-one] fatal:', err.message);
  process.exitCode = 1;
});
