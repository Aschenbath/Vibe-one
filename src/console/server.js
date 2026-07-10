import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRunsRoot } from '../core/runContext.js';
import { createJobManager } from './jobManager.js';
import { createRunStore } from './runStore.js';
import { createPreviewManager } from './previewManager.js';
import { ConsoleError } from './errors.js';
import { readJson, sendBuffer, sendError, sendJson, sendText } from './http.js';

const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

export function createConsoleServer({
  host = '127.0.0.1',
  runsRoot = resolveRunsRoot(),
  pipeline,
  previewStart,
  env = process.env,
} = {}) {
  const jobs = createJobManager({ runsRoot, pipeline, env });
  const store = createRunStore(runsRoot);
  const previews = createPreviewManager({ start: previewStart });
  const sseClients = new Set();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => sendError(res, error));
  });

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, jobs.getStatus());
    }
    if (req.method === 'POST' && pathname === '/api/session/config') {
      return sendJson(res, 200, jobs.setSessionConfig(await readJson(req)));
    }
    if (pathname === '/api/jobs' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: await listJobs() });
    }
    if (pathname === '/api/jobs' && req.method === 'POST') {
      return sendJson(res, 202, await jobs.startJob(await readJson(req)));
    }

    const match = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(events|report|preview|screenshots)(?:\/(.+))?)?$/);
    if (match) {
      const [, id, resource, name] = match;
      if (!resource && req.method === 'GET') return sendJson(res, 200, await getJob(id));
      if (resource === 'events' && req.method === 'GET') return streamEvents(req, res, id);
      if (resource === 'report' && req.method === 'GET') {
        return sendText(res, 200, await store.readReport(await artifactId(id)), 'text/markdown; charset=utf-8');
      }
      if (resource === 'screenshots' && name && req.method === 'GET') {
        return sendBuffer(res, 200, await store.readScreenshot(await artifactId(id), name), 'image/png');
      }
      if (resource === 'preview' && req.method === 'POST') {
        const target = await store.getPreviewTarget(await artifactId(id));
        return sendJson(res, 200, await previews.open(target));
      }
      throw new ConsoleError('ROUTE_NOT_FOUND', 'API route not found.', 404);
    }

    if (pathname.startsWith('/api/')) throw new ConsoleError('ROUTE_NOT_FOUND', 'API route not found.', 404);
    if (req.method !== 'GET') throw new ConsoleError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    return serveStatic(res, pathname);
  }

  async function listJobs() {
    const live = jobs.listLiveJobs();
    const persisted = await store.listRuns();
    const known = new Set(live.flatMap((job) => [job.id, job.runId].filter(Boolean)));
    return [...live, ...persisted.filter((run) => !known.has(run.id))];
  }

  async function getJob(id) {
    const live = jobs.getJob(id);
    if (live) {
      if (live.runId) {
        try {
          const persisted = await store.getRun(live.runId);
          return { ...persisted, ...live, screenshots: persisted.screenshots, repairCount: persisted.repairCount, previewEligible: persisted.previewEligible };
        } catch (error) {
          if (error.code !== 'RUN_NOT_FOUND') throw error;
        }
      }
      return { ...live, screenshots: [], repairCount: 0, previewEligible: false };
    }
    return store.getRun(id);
  }

  async function artifactId(id) {
    const live = jobs.getJob(id);
    if (live && !live.runId) throw new ConsoleError('ARTIFACT_PENDING', 'Artifacts are not ready yet.', 409);
    return live?.runId || id;
  }

  async function streamEvents(req, res, id) {
    const live = jobs.getJob(id);
    if (!live) {
      const run = await store.getRun(id);
      res.writeHead(200, sseHeaders());
      for (const event of run.events) res.write(`data: ${JSON.stringify({ event, job: run })}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, sseHeaders());
    sseClients.add(res);
    for (const event of live.events) res.write(`data: ${JSON.stringify({ event, job: live })}\n\n`);
    if (live.terminal) {
      sseClients.delete(res);
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    const unsubscribe = jobs.subscribe(id, (event, job) => {
      res.write(`data: ${JSON.stringify({ event, job })}\n\n`);
      if (job.terminal) cleanup();
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      sseClients.delete(res);
      if (!res.writableEnded) res.end();
    };
    req.on('close', cleanup);
  }

  async function serveStatic(res, pathname) {
    const asset = STATIC_FILES.get(pathname) || STATIC_FILES.get('/');
    const [name, type] = asset;
    try {
      const content = await fs.readFile(path.join(STATIC_ROOT, name));
      sendBuffer(res, 200, content, type);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ConsoleError('ASSET_NOT_FOUND', 'Console asset not found.', 404);
      throw error;
    }
  }

  function listen(port = 4174) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        resolve({ host, port: address.port, url: `http://${host}:${address.port}/` });
      });
    });
  }

  async function close() {
    previews.close();
    for (const client of sseClients) client.end();
    sseClients.clear();
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  return { listen, close };
}

function sseHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  };
}
