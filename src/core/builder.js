// Builder: spec -> concrete files under runs/<id>/app/.
// The model returns a flat file list; the builder only writes inside appDir.
import fs from 'node:fs/promises';
import path from 'node:path';

const SYSTEM = `You are the builder of a bounded app-replication pipeline.
Target stack: React 18 + Vite, plain CSS, mock data in src/data/. No backend, no auth, no router libs beyond react-router-dom if multiple pages are needed.
Output STRICT JSON: { "files": [{ "path": "relative/path", "content": "file content" }] }
Requirements:
- Must include package.json with scripts: dev, build, preview (vite).
- Must include index.html, src/main.jsx, and one component per planned page.
- Keep total under ~25 files. No binary files. No placeholder TODO stubs for core flows.`;

export async function build(ctx, provider, config, spec) {
  await ctx.logEvent('build:start', { summary: 'generating app files' });
  const user = [
    'Product brief:', config.brief, '',
    'Approved spec JSON:', JSON.stringify(spec, null, 2),
  ].join('\n');

  const { json, usage } = await provider.chatJson({ system: SYSTEM, user });
  ctx.addUsage(usage);

  const files = json.files ?? [];
  if (!files.length) throw new Error('builder returned no files');

  for (const file of files) {
    const abs = safeJoin(ctx.appDir, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf8');
  }
  await ctx.logEvent('build:done', { summary: `${files.length} files written` });
  return files.map((f) => f.path);
}

// Apply fixer patches with the same path safety rules.
export async function applyPatch(ctx, files) {
  for (const file of files) {
    const abs = safeJoin(ctx.appDir, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf8');
  }
}

// Rejects absolute paths and traversal outside appDir.
export function safeJoin(appDir, relPath) {
  const abs = path.resolve(appDir, relPath);
  const rel = path.relative(appDir, abs);
  if (path.isAbsolute(relPath) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`unsafe file path from model: ${relPath}`);
  }
  return abs;
}
