import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard } from '../src/guard.js';

const ok = { enabled: true, healthy: true, memoryOk: true };
const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('refusals come in a fixed order', () => {
  const g = new Guard();
  assert.deepEqual(g.check({ ...ok, enabled: false, healthy: false }), { ok: false, reason: 'disabled' });
  g.begin({ ipHash: 'a', experiment: { id: 1 } });
  assert.equal(g.check({ ...ok, healthy: false }).reason, 'busy');
  g.end();
  assert.equal(g.check({ ...ok, healthy: false, memoryOk: false }).reason, 'healing');
  assert.equal(g.check({ ...ok, memoryOk: false }).reason, 'node-memory');
  assert.deepEqual(g.check({ ...ok, ipHash: 'z' }), { ok: true });
});

test('one visitor waits 60 s between experiments; others do not', () => {
  const c = clock();
  const g = new Guard({ now: c.now });
  g.begin({ ipHash: 'a', experiment: {} }); g.end();
  const r = g.check({ ...ok, ipHash: 'a' });
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryAfterMs, 60_000);
  assert.equal(g.check({ ...ok, ipHash: 'b' }).ok, true);
  c.advance(60_000);
  assert.equal(g.check({ ...ok, ipHash: 'a' }).ok, true);
});

test('heavy actions: at most 3 per rolling hour, across all visitors', () => {
  const c = clock();
  const g = new Guard({ now: c.now });
  for (const ip of ['a', 'b', 'c']) { g.begin({ ipHash: ip, heavy: true, experiment: {} }); g.end(); }
  const r = g.check({ ...ok, ipHash: 'd', heavy: true });
  assert.equal(r.reason, 'hourly-cap');
  assert.equal(g.check({ ...ok, ipHash: 'd', heavy: false }).ok, true);
  c.advance(3_600_000);
  assert.equal(g.check({ ...ok, ipHash: 'd', heavy: true }).ok, true);
});

test('bypass skips cooldown and caps but never the lock or health', () => {
  const g = new Guard();
  for (const ip of ['a', 'b', 'c']) { g.begin({ ipHash: ip, heavy: true, experiment: {} }); g.end(); }
  assert.equal(g.check({ ...ok, ipHash: 'a', heavy: true, bypass: true }).ok, true);
  assert.equal(g.check({ ...ok, healthy: false, bypass: true }).reason, 'healing');
  g.begin({ ipHash: 'x', bypass: true, experiment: {} });
  assert.equal(g.check({ ...ok, bypass: true }).reason, 'busy');
});

test('a spent budget freezes visitors, not the owner or the self-test', () => {
  const g = new Guard();
  assert.deepEqual(g.check({ ...ok, ipHash: 'a', frozen: true }), { ok: false, reason: 'budget-spent' });
  assert.deepEqual(g.check({ ...ok, ipHash: 'a', frozen: true, bypass: true }), { ok: true });
  assert.equal(g.check({ ...ok, enabled: false, frozen: true }).reason, 'disabled'); // the kill switch still speaks first
});
