import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', 'test/console-e2e.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, VIBE_ONE_CONSOLE_E2E: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
