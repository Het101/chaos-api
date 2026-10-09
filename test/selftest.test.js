import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSelftest, summary } from '../src/selftest.js';
import { ACTIONS } from '../src/actions.js';

test('every action has a recovery target in seconds', () => {
  for (const a of ACTIONS) assert.ok(Number.isInteger(a.target) && a.target > 0, a.id);
  assert.equal(ACTIONS.find((a) => a.id === 'hang').target, 90);
});

// A fake chaos-api: each POST starts an experiment that is "running" for one status poll, then lands in the incident log.
function fakeApi({ recoveryMs = {}, refuse = {}, statusOf = {} } = {}) {
  const incidents = [];
  let running = null;
  const calls = [];
  const json = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const path = url.replace('http://api', '');
    calls.push(`${opts.method ?? 'GET'} ${path}`);
    const m = path.match(/^\/chaos\/actions\/(.+)$/);
    if (m && opts.method === 'POST') {
      assert.equal(opts.headers['x-chaos-bypass'], 'tok');
      const r = refuse[m[1]]?.shift();
      if (r) return json(r.status, { reason: r.reason });
      running = { id: `e-${m[1]}`, action: m[1] };
      return json(202, running);
    }
    if (path === '/chaos/status') {
      const exp = running;
      if (running) {
        incidents.unshift({ id: running.id, action: running.action, status: statusOf[running.action] ?? 'recovered', recoveryMs: recoveryMs[running.action] ?? 1000 });
        running = null;
      }
      return json(200, { enabled: false, experiment: exp });
    }
    if (path === '/chaos/incidents') return json(200, incidents);
    throw new Error(`unexpected ${path}`);
  };
  return { fetchImpl, calls };
}

const two = [{ id: 'kill-pod', target: 30 }, { id: 'hang', target: 90 }];
const opts = (api, over = {}) => ({ api: 'http://api', token: 'tok', fetchImpl: api.fetchImpl, sleep: async () => {}, actions: two, ...over });

test('a clean night: every action healed inside its target', async () => {
  const out = await runSelftest(opts(fakeApi({ recoveryMs: { 'kill-pod': 4200, hang: 83_700 } })));
  assert.deepEqual(out.results, [{ id: 'kill-pod', ok: true, ms: 4200, why: '' }, { id: 'hang', ok: true, ms: 83_700, why: '' }]);
  assert.deepEqual(summary(out), { up: true, msg: '2/2 healed inside target' });
});

test('slower than the target, or not healed at all, fails the night', async () => {
  const out = await runSelftest(opts(fakeApi({ recoveryMs: { hang: 95_000 }, statusOf: { 'kill-pod': 'timeout' } })));
  assert.deepEqual(summary(out), { up: false, msg: 'kill-pod: timeout; hang: over target 90 s (95 s)' });
});

test('a busy or healing lab is waited for, then the action runs', async () => {
  const api = fakeApi({ refuse: { 'kill-pod': [{ status: 409, reason: 'healing' }, { status: 409, reason: 'busy' }] } });
  const out = await runSelftest(opts(api));
  assert.equal(out.results[0].ok, true);
  assert.equal(api.calls.filter((c) => c === 'POST /chaos/actions/kill-pod').length, 3);
});

test('the kill switch stops the whole run', async () => {
  const out = await runSelftest(opts(fakeApi({ refuse: { 'kill-pod': [{ status: 503, reason: 'disabled' }] } })));
  assert.deepEqual(summary(out), { up: false, msg: 'aborted: experiments are switched off (chaos-config enabled is not "owner" or "true")' });
});
