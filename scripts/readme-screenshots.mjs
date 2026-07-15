import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  ['--test', 'test/console-e2e.test.js'],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      VIBE_ONE_CONSOLE_E2E: '1',
      VIBE_ONE_CONSOLE_ARTIFACTS: path.join(projectRoot, 'docs', 'screenshots'),
    },
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
