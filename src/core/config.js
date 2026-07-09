// Loads target input + resolves model/run configuration.
// Precedence: input/constraints.json > environment > defaults.
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  stack: 'react-vite',
  viewport: { width: 390, height: 844 },
  maxRepairRounds: 2,
  model: process.env.VIBE_ONE_MODEL || 'gpt-4o-mini',
  baseUrl: process.env.VIBE_ONE_BASE_URL || 'https://api.openai.com/v1',
  temperature: 0.2,
  commandTimeoutMs: 5 * 60 * 1000,
};

export async function loadConfig(targetDir) {
  const inputDir = path.join(targetDir, 'input');
  const briefPath = path.join(inputDir, 'brief.md');

  let brief;
  try {
    brief = await fs.readFile(briefPath, 'utf8');
  } catch {
    throw new Error(`missing required input file: ${briefPath}`);
  }

  let constraints = {};
  try {
    constraints = JSON.parse(await fs.readFile(path.join(inputDir, 'constraints.json'), 'utf8'));
  } catch {
    // constraints.json is optional
  }

  const apiKey = process.env.VIBE_ONE_API_KEY;
  if (!apiKey) {
    throw new Error('VIBE_ONE_API_KEY is not set (see .env.example)');
  }

  return {
    ...DEFAULTS,
    ...constraints,
    apiKey,
    brief,
    inputDir,
  };
}
