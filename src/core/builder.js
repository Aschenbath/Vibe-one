// Builder: spec -> concrete files under runs/<id>/app/.
// Security model:
//  - package.json / vite.config are FIXED templates written by us, never by the model.
//  - The model cannot write manifest, lockfile, npmrc, or config files (FORBIDDEN_FILES).
//  - All model paths pass the safeJoin path jail.
//  - Dependencies are a fixed whitelist; npm install runs with --ignore-scripts.
import fs from 'node:fs/promises';
import path from 'node:path';

const SYSTEM = `You are the builder of a bounded app-replication pipeline.
Target stack: React 18 + Vite, plain CSS, mock data in src/data/.
The build system already provides package.json and vite.config.js - DO NOT output them.
Available dependencies (nothing else is installed): react, react-dom, react-router-dom.
Output STRICT JSON: { "files": [{ "path": "relative/path", "content": "file content" }] }
Requirements:
- Must include index.html at the root and src/main.jsx as the entry.
- One component per planned page; implement the planned interactions with real state updates.
- Keep total under ~25 files. No binary files. No placeholder TODO stubs for core flows.`;

// Files only the pipeline may write. Model attempts to write these are rejected.
const FORBIDDEN_FILES = new Set([
  'package.json',
  'package-lock.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  '.npmrc',
  '.env',
]);

const APP_DEPENDENCIES = {
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^6.28.0',
  },
  devDependencies: {
    vite: '^5.4.11',
    '@vitejs/plugin-react': '^4.3.4',
  },
};

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

export async function build(ctx, provider, config, spec) {
  await ctx.logEvent('build:start', { summary: 'generating app files' });

  await writeScaffold(ctx);

  const user = [
    'Product brief:', config.brief, '',
    'Approved spec JSON:', JSON.stringify(spec, null, 2),
  ].join('\n');

  const { json, usage } = await provider.chatJson({ system: SYSTEM, user });
  ctx.addUsage(usage);

  const files = json.files ?? [];
  if (!files.length) throw new Error('builder returned no files');

  for (const file of files) {
    await writeModelFile(ctx, file);
  }
  await ctx.logEvent('build:done', { summary: `${files.length} files written (+ fixed scaffold)` });
  return files.map((f) => f.path);
}

// Fixed, trusted scaffold: manifest with whitelisted deps + vite config.
async function writeScaffold(ctx) {
  const manifest = {
    name: 'vibe-one-generated-app',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    ...APP_DEPENDENCIES,
  };
  await fs.writeFile(path.join(ctx.appDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await fs.writeFile(path.join(ctx.appDir, 'vite.config.js'), VITE_CONFIG, 'utf8');
}

// Apply fixer patches with the same rules as initial build output.
export async function applyPatch(ctx, files) {
  for (const file of files) {
    await writeModelFile(ctx, file);
  }
}

async function writeModelFile(ctx, file) {
  const abs = safeJoin(ctx.appDir, file.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, file.content, 'utf8');
}

// Rejects absolute paths, traversal outside appDir, and pipeline-owned files.
export function safeJoin(appDir, relPath) {
  const abs = path.resolve(appDir, relPath);
  const rel = path.relative(appDir, abs);
  if (path.isAbsolute(relPath) || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`unsafe file path from model: ${relPath}`);
  }
  const normalized = rel.split(path.sep).join('/').toLowerCase();
  if (FORBIDDEN_FILES.has(normalized) || normalized.startsWith('node_modules/')) {
    throw new Error(`model may not write pipeline-owned file: ${relPath}`);
  }
  return abs;
}
