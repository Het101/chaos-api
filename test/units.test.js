import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytes } from '../src/units.js';

test('binary and decimal suffixes', () => {
  assert.equal(bytes('1024'), 1024);
  assert.equal(bytes('4Ki'), 4096);
  assert.equal(bytes('5024Mi'), 5024 * 1024 ** 2);
  assert.equal(bytes('2Gi'), 2 * 1024 ** 3);
  assert.equal(bytes('3M'), 3e6);
});

test('rejects garbage', () => {
  assert.throws(() => bytes('lots'), /bad quantity/);
});
