// Polisher staging: isolate a bounded candidate before explicit promotion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './builder.js';

export const POLISH_LIMITS = Object.freeze({
  maxFiles: 4,
  maxCharacters: 18_000,
  maxRounds: 1,
});

const DISPOSABLE_SEGMENTS = new Set(['node_modules', 'dist', '.vite']);

export function validatePolishFiles(files, candidateRoot = process.cwd()) {
  if (!Array.isArray(files) || files.length === 0) {
    throw polishOutputLimit('polish files must be a non-empty array');
  }
  if (files.length > POLISH_LIMITS.maxFiles) {
    throw polishOutputLimit(
      'received ' + files.length + ' files; limit is ' + POLISH_LIMITS.maxFiles,
    );
  }

  let characters = 0;
  for (const file of files) {
    if (
      !file
      || typeof file.path !== 'string'
      || !file.path.trim()
      || typeof file.content !== 'string'
    ) {
      throw polishOutputLimit('every polish file requires a path and string content');
    }
    characters += file.content.length;
  }
  if (characters > POLISH_LIMITS.maxCharacters) {
    throw polishOutputLimit(
      'received ' + characters + ' content characters; limit is '
      + POLISH_LIMITS.maxCharacters,
    );
  }

  for (const file of files) {
    try {
      safeJoin(candidateRoot, file.path);
    } catch {
      throw polishOutputLimit('unsafe or pipeline-owned file path: ' + file.path);
    }
  }
  return files;
}

export async function createPolishCandidate(ctx, operations = fs) {
  assertOwnedPolishPaths(ctx);
  await assertPolishSourceSafe(ctx.appDir, operations);
  await operations.rm(ctx.polishCandidateDir, { recursive: true, force: true });
  await assertPolishSourceSafe(ctx.appDir, operations);
  await operations.cp(ctx.appDir, ctx.polishCandidateDir, {
    recursive: true,
    force: true,
    filter(source) {
      const relative = path.relative(ctx.appDir, source);
      if (!relative) return true;
      return !relative.split(path.sep).some(
        (segment) => DISPOSABLE_SEGMENTS.has(segment.toLowerCase()),
      );
    },
  });
  return ctx.polishCandidateDir;
}

export async function promotePolishCandidate(ctx, operations = fs) {
  assertOwnedPolishPaths(ctx);
  assertOwnedChild(ctx.polishDir, ctx.draftAppDir, 'draftAppDir');

  const candidate = await operations.stat(ctx.polishCandidateDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!candidate?.isDirectory()) {
    const error = new Error('POLISH_CANDIDATE_MISSING: polish candidate directory is missing');
    error.code = 'POLISH_CANDIDATE_MISSING';
    throw error;
  }

  await operations.rm(ctx.draftAppDir, { recursive: true, force: true });
  await operations.rename(ctx.appDir, ctx.draftAppDir);
  try {
    await operations.rename(ctx.polishCandidateDir, ctx.appDir);
  } catch (error) {
    try {
      await operations.rename(ctx.draftAppDir, ctx.appDir);
    } catch {
      const rollbackError = new Error(
        'POLISH_ROLLBACK_FAILED: draft retained; manual recovery required',
      );
      rollbackError.code = 'POLISH_ROLLBACK_FAILED';
      rollbackError.draftRetained = true;
      rollbackError.recoveryRequired = true;
      throw rollbackError;
    }
    throw error;
  }
  return ctx.appDir;
}

async function assertPolishSourceSafe(sourceRoot, operations = fs) {
  const entries = await operations.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw polishSourceLinkUnsafe();
    const source = path.join(sourceRoot, entry.name);
    const stats = await operations.lstat(source);
    if (stats.isSymbolicLink()) throw polishSourceLinkUnsafe();
    if (stats.isDirectory()) await assertPolishSourceSafe(source, operations);
  }
}

function assertOwnedPolishPaths(ctx) {
  assertOwnedChild(ctx.runDir, ctx.polishDir, 'polishDir');
  assertOwnedChild(ctx.polishDir, ctx.polishCandidateDir, 'polishCandidateDir');
  assertOwnedChild(ctx.runDir, ctx.appDir, 'appDir');
}

function assertOwnedChild(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('unsafe owned path for ' + label);
  }
}

function polishOutputLimit(detail) {
  const error = new Error('POLISH_OUTPUT_LIMIT: ' + detail);
  error.code = 'POLISH_OUTPUT_LIMIT';
  return error;
}

function polishSourceLinkUnsafe() {
  const error = new Error('POLISH_SOURCE_LINK_UNSAFE: linked source entries are not allowed');
  error.code = 'POLISH_SOURCE_LINK_UNSAFE';
  return error;
}
