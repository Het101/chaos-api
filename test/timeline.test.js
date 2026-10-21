import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, pickExperiment } from '../src/timeline.js';
import { Runner } from '../src/runner.js';
import { Guard } from '../src/guard.js';
import { IncidentLog } from '../src/incidents.js';
import { BudgetPolicy } from '../src/slo.js';
import { runSelftest } from '../src/selftest.js';

const tick = () => new Promise((r) => setImmediate(r));

test('pickExperiment never lets the IP hash out', () => {
  const x = pickExperiment({ id: 'e1', action: 'kill-pod', title: 'Kill a pod', startedAt: 1, ipHash: 'deadbeef', detail: { pod: 'api-1' } });
  assert.deepEqual(x, { id: 'e1', action: 'kill-pod', title: 'Kill a pod', startedAt: 1 });
});

test('createTimeline: a no-op until configured; posts with the token; failures are counted, never thrown', async () => {
  let calls = 0;
  createTimeline({ url: 'http://t', token: '', fetchImpl: async () => { calls++; } })({ phase: 'start' });
  assert.equal(calls, 0);

  const seen = [];
  const errors = [];
  const ok = createTimeline({ url: 'http://t/ingest/chaos', token: 'tok', onError: (e) => errors.push(e.message),
    fetchImpl: async (url, opts) => { seen.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) }); return { ok: true, body: null }; } });
  assert.equal(ok({ phase: 'start', actor: 'a visitor' }), undefined, 'fire and forget: returns nothing to await');
  await tick();
  assert.deepEqual(seen, [{ url: 'http://t/ingest/chaos', auth: 'Bearer tok', body: { phase: 'start', actor: 'a visitor' } }]);

  createTimeline({ url: 'http://t', token: 'tok', onError: (e) => errors.push(e.message), fetchImpl: async () => ({ ok: false, status: 401 }) })({});
  createTimeline({ url: 'http://t', token: 'tok', onError: (e) => errors.push(e.message), sleep: async () => {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })({});
  await tick();
  assert.deepEqual(errors, ['timeline answered 401', 'ECONNREFUSED']);
});

test('the runner reports start and finish, owner for the bypass, a visitor otherwise', async () => {
  let t = 0;
  const sent = [];
  const runner = new Runner({
    cfg: { experimentTimeoutMs: 60_000 },
    guard: new Guard({ now: () => t }),
    incidents: new IncidentLog(),
    broadcast: () => {},
    health: async () => ({ healthy: true, reasons: [] }),
    callMs: 20, memory: async () => true, readEnabled: async () => true,
    ctx: { k8s: { scaleDeployment: async () => {} }, cfg: { appNamespace: 'clinic' } },
    now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 2000, minObserveMs: 15_000,
    timeline: (body) => sent.push(body),
  });
  await runner.start({ actionId: 'scale-zero', ipHash: 'deadbeef' });
  await runner.observing;
  assert.deepEqual(sent.map((b) => [b.phase, b.actor, b.experiment.action]), [['start', 'a visitor', 'scale-zero'], ['finish', 'a visitor', 'scale-zero']]);
  assert.equal(sent[1].experiment.status, 'recovered');
  assert.ok(!JSON.stringify(sent).includes('deadbeef'));

  t += 120_000; // past the cooldown
  await runner.start({ actionId: 'scale-zero', ipHash: 'x', bypass: true });
  await runner.observing;
  assert.equal(sent[2].actor, 'owner');
});

test('the budget policy reports freezing and reopening, once each', async () => {
  const budgets = [0.2, -0.01, -0.02, 0.03, 0.06, 0.07];
  const reader = { poll: async () => {}, read: () => ({ budget: budgets.shift(), sli7d: 0.99, burn5m: 1, burn1h: 1 }) };
  const changes = [];
  const p = new BudgetPolicy({ reader, onChange: (frozen, budget) => changes.push([frozen, budget]) });
  for (let i = 0; i < 6; i++) await p.tick();
  assert.deepEqual(changes, [[true, -0.01], [false, 0.06]]);
});

test('self-test: an extra "timeline" line checks every experiment is on the timeline', async () => {
  const ids = [];
  const fetchImpl = async (url, opts = {}) => {
    const json = (status, body) => ({ status, json: async () => body });
    if (opts.method === 'POST') { const id = `e${ids.length}`; ids.push(id); return json(202, { id }); }
    if (url.endsWith('/chaos/status')) return json(200, { experiment: null });
    if (url.endsWith('/chaos/incidents')) return json(200, ids.map((id) => ({ id, status: 'recovered', recoveryMs: 1000 })));
    // The timeline has both events for e0 but only the start of e1.
    return json(200, [
      { source: 'chaos', ref: { experimentId: 'e0' } }, { source: 'chaos', ref: { experimentId: 'e0' } },
      { source: 'chaos', ref: { experimentId: 'e1' } }, { source: 'k8s', ref: {} },
    ]);
  };
  const actions = [{ id: 'kill-pod', target: 30 }, { id: 'crash', target: 30 }];
  const { results } = await runSelftest({ api: 'http://api', token: 'tok', actions, fetchImpl, sleep: async () => {}, timelineUrl: 'https://lab.hetops.dev/timeline' });
  assert.deepEqual(results.at(-1), { id: 'timeline', ok: false, why: '1 of 2 experiments missing start or finish' });

  const off = await runSelftest({ api: 'http://api', token: 'tok', actions, fetchImpl, sleep: async () => {} });
  assert.ok(!off.results.some((r) => r.id === 'timeline'), 'no TIMELINE_CHECK_URL, no check');
});

test('createTimeline: a restart is ridden out (5xx and network errors retried); a 4xx is not', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const answers = [() => { throw new Error('ECONNREFUSED'); }, () => ({ ok: false, status: 503 }), () => ({ ok: true })];
  const errors = [];
  createTimeline({ url: 'http://t', token: 'tok', sleep, onError: (e) => errors.push(e.message), fetchImpl: async () => answers[calls++]() })({ phase: 'finish' });
  await tick();
  assert.equal(calls, 3, 'down, starting, up');
  assert.deepEqual(waits, [2000, 5000]);
  assert.deepEqual(errors, []);

  let tries = 0;
  createTimeline({ url: 'http://t', token: 'tok', sleep, onError: (e) => errors.push(e.message), fetchImpl: async () => { tries++; return { ok: false, status: 401 }; } })({});
  let down = 0;
  createTimeline({ url: 'http://t', token: 'tok', sleep, onError: (e) => errors.push(e.message), fetchImpl: async () => { down++; return { ok: false, status: 503 }; } })({});
  await tick();
  assert.equal(tries, 1, 'a wrong token is not retried');
  assert.equal(down, 5, 'one try and four retries, then it gives up');
  assert.deepEqual(errors, ['timeline answered 401', 'timeline answered 503']);
});
