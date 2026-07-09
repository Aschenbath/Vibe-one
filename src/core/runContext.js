// Run context: creates runs/<run-id>/ layout and a structured event log.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createRunContext(targetDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = `${path.basename(targetDir)}-${stamp}`;
  const runDir = path.join(targetDir, '..', '..', 'runs', runId);

  const dirs = {
    runDir,
    appDir: path.join(runDir, 'app'),
    logsDir: path.join(runDir, 'logs'),
    screenshotsDir: path.join(runDir, 'screenshots'),
  };
  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const events = [];
  const eventLogPath = path.join(dirs.logsDir, 'events.jsonl');

  async function logEvent(type, data = {}) {
    const event = { ts: new Date().toISOString(), type, ...data };
    events.push(event);
    await fs.appendFile(eventLogPath, JSON.stringify(event) + '\n', 'utf8');
    console.log(`[${type}]`, data.summary ?? '');
  }

  // Cumulative token/cost usage across all model calls in this run.
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  function addUsage(u) {
    if (!u) return;
    usage.promptTokens += u.prompt_tokens ?? 0;
    usage.completionTokens += u.completion_tokens ?? 0;
    usage.calls += 1;
  }

  return { runId, ...dirs, events, logEvent, usage, addUsage };
}
