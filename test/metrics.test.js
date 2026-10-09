import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, countProbe } from '../src/metrics.js';
import { Runner } from '../src/runner.js';
import { Guard } from '../src/guard.js';
import { IncidentLog } from '../src/incidents.js';
import { Prober } from '../src/prober.js';
import { buildApp } from '../src/app.js';

function runnerWith(metrics, healthSeq, timeoutMs = 60_000) {
  let t = 0;
  const seq = [...healthSeq];
  const runner = new Runner({
    cfg: { experimentTimeoutMs: timeoutMs }, guard: new Guard({ now: () => t }),
    incidents: new IncidentLog({ save: async () => {} }), broadcast: () => {},
    health: async () => ({ healthy: seq.length > 1 ? seq.shift() : seq[0], reasons: [] }),
    memory: async () => true, readEnabled: async () => true,
    ctx: { k8s: { scaleDeployment: async () => {} }, cfg: { appNamespace: 'clinic' } },
    now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 2000, minObserveMs: 15_000, metrics,
  });
  return runner;
}

test('a recovered experiment is counted and its recovery time observed', async () => {
  const m = createMetrics();
  const runner = runnerWith(m, [true, false, true]);
  await runner.start({ actionId: 'scale-zero', ipHash: 'a' });
  await runner.observing;
  const out = await m.register.metrics();
  assert.match(out, /chaos_experiments_total\{action="scale-zero",status="recovered"\} 1/);
  assert.match(out, /chaos_recovery_seconds_count\{action="scale-zero"\} 1/);
});

test('a timeout is counted but not observed as a recovery', async () => {
  const m = createMetrics();
  const runner = runnerWith(m, [true, false], 10_000);
  await runner.start({ actionId: 'scale-zero', ipHash: 'a' });
  await runner.observing;
  const out = await m.register.metrics();
  assert.match(out, /chaos_experiments_total\{action="scale-zero",status="timeout"\} 1/);
  assert.doesNotMatch(out, /chaos_recovery_seconds_count\{action/);
});

test('prober hands each visit to onResult; visits map to probe counters', async () => {
  const m = createMetrics();
  const seen = [];
  const replies = [{ ok: true, status: 200 }, { ok: true, status: 200 }, { ok: false, status: 500 }, { ok: true, status: 200 }];
  const p = new Prober({ url: 'http://api', webUrl: 'http://web', json: false,
    fetchImpl: async () => ({ ...replies.shift(), headers: { get: () => null }, body: { cancel: async () => {} } }),
    onResult: (e) => { seen.push(e); countProbe(m.probes, e); } });
  await p.tick(); // web ok, api ok
  await p.tick(); // web fail, api ok
  assert.equal(seen.length, 2);
  const out = await m.register.metrics();
  assert.match(out, /chaos_probe_requests_total\{tier="api",result="ok"\} 2/);
  assert.match(out, /chaos_probe_requests_total\{tier="web",result="ok"\} 1/);
  assert.match(out, /chaos_probe_requests_total\{tier="web",result="fail"\} 1/);
  countProbe(m.probes, { ok: false }); // no web tier on this entry
  assert.match(await m.register.metrics(), /chaos_probe_requests_total\{tier="api",result="fail"\} 1/);
});

const deps = { cfg: { allowedOrigin: 'x' }, logger: false, runner: {}, stream: {}, incidents: {}, verifyTurnstile: async () => false };

test('GET /metrics serves the registry, and 404s when no metrics are wired', async () => {
  const m = createMetrics();
  m.experiments.inc({ action: 'kill-pod', status: 'recovered' });
  const res = await buildApp({ ...deps, metrics: m }).inject('/metrics');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.body, /chaos_experiments_total/);
  assert.equal((await buildApp(deps).inject('/metrics')).statusCode, 404);
});
