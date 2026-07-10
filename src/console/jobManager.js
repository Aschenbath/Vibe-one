import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPipeline } from '../core/pipeline.js';
import { loadConfig } from '../core/config.js';
import { ConsoleError } from './errors.js';

const TERMINAL = new Set(['success', 'failed', 'planned']);

export function createJobManager({ runsRoot, pipeline = runPipeline, load = loadConfig, env = process.env }) {
  const jobs = new Map();
  const subscribers = new Map();
  const session = { apiKey: '', baseUrl: '', model: '' };
  let activeJobId = null;

  function setSessionConfig(next = {}) {
    for (const key of ['apiKey', 'baseUrl', 'model']) {
      if (Object.hasOwn(next, key)) session[key] = String(next[key] ?? '').trim();
    }
    return getStatus();
  }

  function getStatus() {
    return {
      ready: true,
      hasApiKey: Boolean(session.apiKey || env.VIBE_ONE_API_KEY),
      baseUrl: session.baseUrl || env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1',
      model: session.model || env.VIBE_ONE_MODEL || 'gpt-4o-mini',
      activeJobId,
    };
  }

  async function startJob(input = {}) {
    if (activeJobId) throw new ConsoleError('JOB_ACTIVE', 'Another job is already running.', 409);

    const brief = String(input.brief ?? '').trim();
    if (!brief) throw new ConsoleError('BRIEF_REQUIRED', 'Describe the app before starting.', 422);
    if (brief.length > 100_000) {
      throw new ConsoleError('BRIEF_TOO_LARGE', 'Briefs are limited to 100,000 characters.', 413);
    }

    const mode = input.mode === 'plan' ? 'plan' : input.mode === 'run' ? 'run' : null;
    if (!mode) throw new ConsoleError('MODE_INVALID', 'Mode must be run or plan.', 422);

    const apiKey = session.apiKey || env.VIBE_ONE_API_KEY;
    if (!apiKey) throw new ConsoleError('API_KEY_REQUIRED', 'Enter an API key for this session.', 422);

    const id = randomUUID();
    const title = String(input.title ?? 'Untitled app').trim().slice(0, 80) || 'Untitled app';
    const targetDir = path.join(runsRoot, '.console-inputs', `${slugTitle(title)}-${id.slice(0, 8)}`);
    const baseUrl = String(input.baseUrl || session.baseUrl || env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1');
    const model = String(input.model || session.model || env.VIBE_ONE_MODEL || 'gpt-4o-mini');

    await fs.mkdir(path.join(targetDir, 'input'), { recursive: true });
    await fs.writeFile(path.join(targetDir, 'input', 'brief.md'), brief, 'utf8');
    await fs.writeFile(
      path.join(targetDir, 'input', 'constraints.json'),
      JSON.stringify({ model, baseUrl }, null, 2),
      'utf8',
    );

    const job = {
      id,
      title,
      mode,
      model,
      baseUrl,
      status: 'queued',
      stage: 'queued',
      createdAt: new Date().toISOString(),
      completedAt: null,
      runId: null,
      runDir: null,
      events: [],
      secret: apiKey,
      promise: null,
    };
    jobs.set(id, job);
    activeJobId = id;
    job.promise = execute(job, { targetDir, apiKey });
    return publicJob(job);
  }

  async function execute(job, { targetDir, apiKey }) {
    try {
      const config = await load(targetDir, { apiKey });
      config.runsRoot = runsRoot;
      config.onEvent = (event) => acceptEvent(job, event);
      const result = await pipeline({ targetDir, config, planOnly: job.mode === 'plan' });
      job.status = result.status;
      job.stage = result.status;
      job.runId = result.runId;
      job.runDir = result.runDir;
    } catch (error) {
      job.status = 'failed';
      job.stage = 'failed';
      acceptEvent(job, { ts: new Date().toISOString(), type: 'fatal', summary: error.message });
    } finally {
      job.completedAt = new Date().toISOString();
      job.secret = '';
      activeJobId = null;
      publish(job);
    }
  }

  function acceptEvent(job, event) {
    const clean = {
      ts: event.ts || new Date().toISOString(),
      type: String(event.type || 'event'),
      summary: sanitize(event.summary, job.secret),
      ...(event.name ? { name: sanitize(event.name, job.secret) } : {}),
    };
    job.events.push(clean);
    job.stage = stageForEvent(clean.type, job.stage);
    publish(job, clean);
  }

  function subscribe(id, listener) {
    if (!jobs.has(id)) throw new ConsoleError('JOB_NOT_FOUND', 'Job not found.', 404);
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(listener);
    return () => subscribers.get(id)?.delete(listener);
  }

  function publish(job, event = null) {
    for (const listener of subscribers.get(job.id) ?? []) listener(event, publicJob(job));
  }

  function getJob(id) {
    return jobs.has(id) ? publicJob(jobs.get(id), true) : null;
  }

  function listLiveJobs() {
    return [...jobs.values()].map((job) => publicJob(job));
  }

  function waitForJob(id) {
    return jobs.get(id)?.promise ?? Promise.resolve();
  }

  return {
    setSessionConfig,
    getStatus,
    startJob,
    getJob,
    listLiveJobs,
    waitForJob,
    subscribe,
  };
}

function stageForEvent(type, current) {
  if (type.startsWith('plan:')) return 'planning';
  if (type.startsWith('build:')) return 'building';
  if (type.startsWith('fix:') || type.startsWith('repair:')) return 'repairing';
  if (['cmd:start', 'cmd:done', 'preview:start', 'preview:ready', 'screenshot', 'scenario', 'review'].includes(type)) {
    return 'verifying';
  }
  if (type === 'fatal') return 'failed';
  return current;
}

function publicJob(job, includeEvents = false) {
  return {
    id: job.id,
    title: job.title,
    mode: job.mode,
    model: job.model,
    baseUrl: job.baseUrl,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    runId: job.runId,
    terminal: TERMINAL.has(job.status),
    hasReport: Boolean(job.runDir),
    ...(includeEvents ? { events: [...job.events] } : {}),
  };
}

function sanitize(value, secret) {
  const text = String(value ?? '');
  return secret ? text.split(secret).join('[redacted]') : text;
}

function slugTitle(title) {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
}
