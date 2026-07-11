import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePixelSamples } from '../src/runner/visualCompare.js';

const solid = (r, g, b, count = 64) => Uint8Array.from(
  Array.from({ length: count }, () => [r, g, b, 255]).flat(),
);

test('visual scoring is deterministic and rewards structural/color identity', () => {
  const white = solid(255, 255, 255);
  const black = solid(0, 0, 0);
  const same = scorePixelSamples(white, white);
  const different = scorePixelSamples(white, black);

  assert.equal(same.score, 1);
  assert.equal(same.structure, 1);
  assert.equal(same.color, 1);
  assert.ok(different.score < 0.15, JSON.stringify(different));
});

test('visual scoring rejects unequal or incomplete RGBA samples', () => {
  assert.throws(
    () => scorePixelSamples(Uint8Array.from([0, 0, 0, 255]), Uint8Array.from([])),
    /equal RGBA lengths/,
  );
  assert.throws(
    () => scorePixelSamples(Uint8Array.from([0, 0, 0]), Uint8Array.from([0, 0, 0])),
    /equal RGBA lengths/,
  );
});
