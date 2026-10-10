import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../src/runner.js';
import { Guard } from '../src/guard.js';
import { IncidentLog } from '../src/incidents.js';

function setup({ healthSeq = [true], enabled = true, timeoutMs = 60_000, health } = {}) {
  let t = 0;
  const events = [];
  const saved = [];
  const healthy = [...healthSeq];
  const runner = new Runner({
    cfg: { experimentTimeoutMs: timeoutMs },
    guard: new Guard({ now: () => t }),
    incidents: new IncidentLog({ save: async (items) => { saved.push(items.length); } }),
    broadcast: (event, data) => events.push([event, data.status]),
    health: health ?? (async () => ({ healthy: healthy.length > 1 ? healthy.shift() : healthy[0], reasons: [] })),
    callMs: 20,
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

test('a failing action is logged but still observed before the lock is released', async () => {
  const { runner } = setup({ healthSeq: [true, false, true] });
  runner.ctx = { k8s: { deleteSecret: async () => { throw Object.assign(new Error('secret body'), { code: 404 }); } }, cfg: { appNamespace: 'clinic' } };
  const res = await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  assert.equal(res.experiment.status, 'action-failed');
  assert.equal(res.experiment.error, 'HTTP 404');
  assert.notEqual(runner.guard.running, null);
  await runner.observing;
  const exp = runner.incidents.list()[0];
  assert.equal(exp.status, 'recovered');
  assert.equal(exp.error, 'HTTP 404');
  assert.equal(runner.guard.running, null);
});

test('hang is observed for at least its own window', async () => {
  const { runner } = setup({ timeoutMs: 600_000 });
  runner.ctx = { k8s: { listPods: async () => [{ metadata: { name: 'p' }, status: { podIP: '1.1.1.1', conditions: [{ type: 'Ready', status: 'True' }] } }] }, http: async () => {}, cfg: { appNamespace: 'clinic', internalToken: 't' } };
  await runner.start({ actionId: 'hang', ipHash: 'a' });
  await runner.observing;
  assert.equal(runner.incidents.list()[0].recoveryMs, 76_000);
});

test('a hung health call counts as unhealthy and the timeout is wall-clock', { timeout: 3000 }, async () => {
  let calls = 0;
  // first call is the pre-flight check; every later one hangs
  const { runner } = setup({ timeoutMs: 10_000, health: () => (calls++ ? new Promise(() => {}) : Promise.resolve({ healthy: true, reasons: [] })) });
  runner.ctx = { k8s: { deleteSecret: async () => {} }, cfg: { appNamespace: 'clinic' } };
  await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  await runner.observing;
  const exp = runner.incidents.list()[0];
  assert.equal(exp.status, 'timeout');
  assert.deepEqual(exp.reasons, ['unreachable']);
  assert.equal(runner.guard.running, null);
});

test('a hung action does not hold the lock forever', { timeout: 3000 }, async () => {
  const { runner } = setup({ timeoutMs: 4_000 });
  runner.runMs = 20;
  runner.ctx = { k8s: { deleteSecret: () => new Promise(() => {}) }, cfg: { appNamespace: 'clinic' } };
  const res = await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  assert.equal(res.experiment.status, 'action-failed');
  await runner.observing;
  assert.equal(runner.guard.running, null);
});

test('times out if the lab never recovers', async () => {
  const { runner } = setup({ healthSeq: [true, false] });
  runner.ctx = { k8s: { deleteSecret: async () => {} }, cfg: { appNamespace: 'clinic' } };
  await runner.start({ actionId: 'delete-secret', ipHash: 'a' });
  await runner.observing;
  assert.equal(runner.incidents.list()[0].status, 'timeout');
});

test('owner mode: only bypass requests may start experiments', async () => {
  const { runner } = setup({ enabled: 'owner' });
  runner.ctx = { k8s: { deleteSecret: async () => {} }, cfg: { appNamespace: 'clinic' } };
  assert.equal((await runner.start({ actionId: 'delete-secret', ipHash: 'a' })).reason, 'disabled');
  assert.equal((await runner.start({ actionId: 'delete-secret', ipHash: 'a', bypass: true })).ok, true);
  await runner.observing;
});

test('the switch accepts only exact values', async () => {
  for (const enabled of ['false', '', 'yes', null]) {
    const { runner } = setup({ enabled });
    assert.equal((await runner.start({ actionId: 'scale-zero', ipHash: 'a', bypass: true })).reason, 'disabled', String(enabled));
  }
});

test('F7: never recovered before the action has finished its own work', async () => {
  // traffic-spike breaks things early (new pods starting), is healthy again at 4 s, but its load runs on
  const { runner } = setup({ healthSeq: [true, false, true], timeoutMs: 600_000 });
  runner.ctx = { load: () => {}, cfg: {} };
  await runner.start({ actionId: 'traffic-spike', ipHash: 'a', bypass: true });
  await runner.observing;
  const exp = runner.incidents.list()[0];
  assert.equal(exp.status, 'recovered');
  assert.ok(exp.recoveryMs >= 100_000, `recovered too early: ${exp.recoveryMs}`);
});

test('F3: recovered only once users are served again, and user errors count as breakage', async () => {
  const { runner } = setup({ healthSeq: [true] });
  const userSeq = [false, false, false, true];
  runner.userOk = () => (userSeq.length > 1 ? userSeq.shift() : userSeq[0]);
  runner.ctx = { k8s: { deletePod: async () => {} }, cfg: { dataNamespace: 'clinic-data' } };
  await runner.start({ actionId: 'kill-postgres', ipHash: 'a' });
  await runner.observing;
  // pods looked healthy throughout; users failed for 3 polls (2, 4, 6 s), served again at 8 s
  assert.equal(runner.incidents.list()[0].recoveryMs, 8000);
});

test('a frozen budget refuses visitors before anything runs', async () => {
  const { runner } = setup();
  runner.frozen = () => true;
  assert.equal((await runner.start({ actionId: 'scale-zero', ipHash: 'a' })).reason, 'budget-spent');
});

test('cost = bad visits during the experiment / the weekly allowance', async () => {
  const { runner } = setup({ healthSeq: [true, false, true] });
  runner.ctx = { k8s: { scaleDeployment: async () => {} }, cfg: { appNamespace: 'clinic' } };
  // Read once at start (100 already bad: they do not count), once at finish (402). Fixed answers, so no race with
  // the background observer, which can finish before the test's next line runs.
  const reads = [100, 402];
  runner.badVisits = () => reads.shift();
  await runner.start({ actionId: 'scale-zero', ipHash: 'a' });
  await runner.observing;
  const exp = runner.incidents.list()[0];
  assert.equal(exp.status, 'recovered');
  assert.equal(exp.cost, 302 / 30_240);
});
