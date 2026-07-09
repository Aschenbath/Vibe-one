// Offline unit tests: no network, no model. Pins the safety-critical helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeJoin } from '../src/core/builder.js';
import { extractJson } from '../src/providers/openaiCompatible.js';
import { review } from '../src/core/reviewer.js';
import { describeFailure } from '../src/core/fixer.js';

const APP = path.resolve('/tmp/run/app');

test('safeJoin allows normal relative paths', () => {
  assert.equal(safeJoin(APP, 'src/main.jsx'), path.resolve(APP, 'src/main.jsx'));
});

test('safeJoin rejects traversal and absolute paths', () => {
  assert.throws(() => safeJoin(APP, '../outside.txt'));
  assert.throws(() => safeJoin(APP, '..\\outside.txt'));
  assert.throws(() => safeJoin(APP, path.resolve('/etc/passwd')));
  assert.throws(() => safeJoin(APP, 'C:\\Windows\\evil.js'));
});

test('safeJoin rejects pipeline-owned files', () => {
  assert.throws(() => safeJoin(APP, 'package.json'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'vite.config.js'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, '.npmrc'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'node_modules/react/index.js'), /pipeline-owned/);
  // normal app files still allowed
  assert.ok(safeJoin(APP, 'src/App.jsx'));
});

test('extractJson tolerates markdown fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('not json'));
});

const okShot = { page: 'Home', route: '/', bytes: 60_000, text: 'x'.repeat(100), file: 'home.png' };

test('review passes only when everything is green', () => {
  const spec = { pages: [{ name: 'Home', route: '/' }] };
  const good = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec });
  assert.equal(good.pass, true);

  const badBuild = review({ install: { exitCode: 0 }, build: { exitCode: 1 }, shots: [okShot], spec });
  assert.equal(badBuild.pass, false);

  const emptyShot = review({
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [{ ...okShot, bytes: 100, text: '' }],
    spec,
  });
  assert.equal(emptyShot.pass, false);

  const missingPage = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [], spec });
  assert.equal(missingPage.pass, false);
});

test('review enforces mustContain page content', () => {
  const spec = { pages: [{ name: 'Home', route: '/', mustContain: ['本月支出', '¥'] }] };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 } };

  const good = review({ ...base, shots: [{ ...okShot, text: '本月支出 ¥1234 记一笔' + 'x'.repeat(50) }], spec });
  assert.equal(good.pass, true);

  const missing = review({ ...base, shots: [{ ...okShot, text: 'hello world' + 'x'.repeat(50) }], spec });
  assert.equal(missing.pass, false);
  assert.ok(missing.failed.some((c) => c.name.includes('本月支出')));
});

test('review enforces interaction scenarios', () => {
  const spec = {
    pages: [{ name: 'Home', route: '/' }],
    scenarios: [{ name: 'add expense shows new row', route: '/', steps: [], expectText: '新记录' }],
  };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec };

  const pass = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: true }] });
  assert.equal(pass.pass, true);

  const fail = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: false, error: 'text not found' }] });
  assert.equal(fail.pass, false);

  const notRun = review({ ...base, scenarioResults: [] });
  assert.equal(notRun.pass, false);
});

test('describeFailure includes build stderr and failed checks', () => {
  const text = describeFailure({
    install: { exitCode: 0 },
    build: { exitCode: 1, stderr: 'SyntaxError: unexpected token' },
    shots: [],
    reviewResult: { failed: [{ name: 'npm run build passes', detail: 'exit=1' }] },
  });
  assert.match(text, /BUILD FAILED/);
  assert.match(text, /SyntaxError/);
  assert.match(text, /REVIEW CHECKS FAILED/);
});
