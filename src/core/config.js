// Loads target input + resolves model/run configuration.
// Precedence: input/constraints.json > environment > defaults.
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverReferenceImages } from './referenceImages.js';

const DEFAULTS = {
  stack: 'react-vite',
  viewport: { width: 390, height: 844 },
  maxRepairRounds: 2,
  maxPolishRounds: 1,
  model: process.env.VIBE_ONE_MODEL || 'gpt-4o-mini',
  baseUrl: process.env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1',
  userAgent: process.env.VIBE_ONE_USER_AGENT || '',
  temperature: 0.2,
  commandTimeoutMs: 5 * 60 * 1000,
  // Network resilience for flaky/shared gateways. maxNetworkRetries applies to
  // both transient fetch failures and 429s; requestTimeoutMs bounds each attempt.
  maxNetworkRetries: Number(process.env.VIBE_ONE_MAX_RETRIES) || 6,
  requestTimeoutMs: Number(process.env.VIBE_ONE_REQUEST_TIMEOUT_MS) || 120_000,
  streamRequestTimeoutMs: Number(process.env.VIBE_ONE_STREAM_TIMEOUT_MS) || 600_000,
  visualThreshold: Number(process.env.VIBE_ONE_VISUAL_THRESHOLD) || 0.62,
};

export async function loadConfig(targetDir, overrides = {}) {
  const inputDir = path.join(targetDir, 'input');
  const briefPath = path.join(inputDir, 'brief.md');

  const brief = await fs.readFile(briefPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const references = await discoverReferenceImages(inputDir);
  if (!brief.trim() && references.length === 0) {
    throw new Error('INPUT_REQUIRED: provide brief text or at least one reference image');
  }

  let constraints = {};
  try {
    constraints = JSON.parse(await fs.readFile(path.join(inputDir, 'constraints.json'), 'utf8'));
  } catch {
    // constraints.json is optional
  }

  if (
    constraints.maxPolishRounds !== undefined
    && constraints.maxPolishRounds !== 1
  ) {
    const error = new Error('CONFIG_INVALID: maxPolishRounds must be 1');
    error.code = 'CONFIG_INVALID';
    throw error;
  }

  const apiKey = overrides.apiKey || process.env.VIBE_ONE_API_KEY;
  if (!apiKey) {
    throw new Error('VIBE_ONE_API_KEY is not set (see .env.example)');
  }

  return {
    ...DEFAULTS,
    ...constraints,
    maxPolishRounds: 1,
    apiKey,
    brief,
    references,
    inputDir,
  };
}
