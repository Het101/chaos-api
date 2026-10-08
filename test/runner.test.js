import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/runner.js';
import { Guard } from '../src/guard.js';
import { IncidentLog } from '../src/incidents.js';

function setup({ healthSeq = [true], enabled = true } = {}) {
  let t = 0;
  const events = [];
  const saved = [];
  const healthy = [...healthSeq];
  const runner = new Runner({
    cfg: { experimentTimeoutMs: 60_000 },
    guard: new Guard({ now: () => t }),
    incidents: new IncidentLog({ save: async (items) => { saved.push(items.length); } }),
    broadcast: (event, data) => events.push([event, data.status]),
    health: async () => ({ healthy: healthy.length > 1 ? healthy.shift() : healthy[0], reasons: [] }),
    memory: async () => true,
    readEnabled: async () => enabled,
    ctx: {},
    now: () => t,
    sleep: async (ms) => { t += ms; },
    pollMs: 2000,
    minObserveMs: 15_000,
  });
  return { runner, events, saved, tick: (ms) => { t += ms; } };
}

test('unknown action and guard refusals are reported, not run', async () => {
  const { runner } = setup({ enabled: false });
  assert.deepEqual(await runner.start({ actionId: 'nope', ipHash: 'a' }), { ok: false, reason: 'unknown-action' });
  assert.equal((await runner.start({ actionId: 'scale-zero', ipHash: 'a' })).reason, 'disabled');
});

test('records recovery time once the lab is healthy again after breaking', async () => {
  // healthy before start, broken twice, then healthy
  const { runner, events } = setup({ healthSeq: [true, false, false, true] });
  runner.ctx = { k8s: { scaleDeployment: async () => {} }, cfg: { appNamespace: 'clinic' } };
  const res = await runner.start({ actionId: 'scale-zero', ipHash: 'a' });
  assert.equal(res.ok, true);
  await runner.observing;
  const exp = runner.incidents.list()[0];
  assert.equal(exp.status, 'recovered');
  assert.equal(exp.recoveryMs, 6000);
  assert.deepEqual(events.map((e) => e[1]), ['running', 'recovered']);
  assert.equal(runner.guard.running, null);
});

test('waits at least the minimum observation window if nothing visibly broke', async () => {
  const { runner } = setup({ healthSeq: [true] });
  runner.ctx = { k8s: { deleteSecret: async () => {} }, cfg: { appNamespace: 'clinic' } };
  await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  await runner.observing;
  assert.equal(runner.incidents.list()[0].recoveryMs, 16_000);
});

test('a failing action releases the lock and is logged', async () => {
  const { runner } = setup();
  runner.ctx = { k8s: { deleteSecret: async () => { throw new Error('forbidden'); } }, cfg: { appNamespace: 'clinic' } };
  const res = await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  assert.equal(res.experiment.status, 'action-failed');
  assert.equal(res.experiment.error, 'forbidden');
  assert.equal(runner.guard.running, null);
});

test('times out if the lab never recovers', async () => {
  const { runner } = setup({ healthSeq: [true, false] });
  runner.ctx = { k8s: { deleteSecret: async () => {} }, cfg: { appNamespace: 'clinic' } };
  await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  await runner.observing;
  assert.equal(runner.incidents.list()[0].status, 'timeout');
});
