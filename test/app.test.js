import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const cfg = { allowedOrigin: 'https://hetops.dev', bypassToken: 'bypass', turnstileSecret: 's', ipSalt: 'salt' };
function make(over = {}) {
  const starts = [];
  const app = buildApp({
    cfg, logger: false,
    runner: { start: async (args) => { starts.push(args); return over.result ?? { ok: true, experiment: { id: 'e1', status: 'running' } }; } },
    stream: { add() {}, send() {} },
    incidents: { list: () => [{ id: 'old' }] },
    verifyTurnstile: async ({ token }) => token === 'human',
    ...over.deps,
  });
  return { app, starts };
}

test('menu and incidents are public reads', async () => {
  const { app } = make();
  const menu = (await app.inject('/chaos/actions')).json();
  assert.equal(menu.length, 15);
  assert.deepEqual(Object.keys(menu[0]), ['id', 'title', 'heavy']);
  assert.deepEqual((await app.inject('/chaos/incidents')).json(), [{ id: 'old' }]);
  assert.equal((await app.inject('/chaos/health')).statusCode, 200);
});

test('an action needs a valid Turnstile token', async () => {
  const { app, starts } = make();
  const res = await app.inject({ method: 'POST', url: '/chaos/actions/kill-pod', payload: { turnstileToken: 'bot' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { reason: 'turnstile' });
  assert.equal(starts.length, 0);
});

test('a human starts an experiment; only a hash of the IP is passed on', async () => {
  const { app, starts } = make();
  const res = await app.inject({ method: 'POST', url: '/chaos/actions/kill-pod', payload: { turnstileToken: 'human' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(res.statusCode, 202);
  assert.equal(starts[0].actionId, 'kill-pod');
  assert.match(starts[0].ipHash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(starts).includes('203.0.113.9'));
  assert.equal(starts[0].bypass, false);
});

test('the bypass header skips Turnstile, compared exactly', async () => {
  const { app, starts } = make();
  assert.equal((await app.inject({ method: 'POST', url: '/chaos/actions/kill-pod', payload: {}, headers: { 'x-chaos-bypass': 'bypass' } })).statusCode, 202);
  assert.equal(starts[0].bypass, true);
  assert.equal((await app.inject({ method: 'POST', url: '/chaos/actions/kill-pod', payload: {}, headers: { 'x-chaos-bypass': 'bypasss' } })).statusCode, 403);
});

test('refusals map to HTTP statuses', async () => {
  for (const [reason, code] of [['busy', 409], ['healing', 409], ['cooldown', 429], ['hourly-cap', 429], ['disabled', 503], ['node-memory', 503], ['unknown-action', 404]]) {
    const { app } = make({ result: { ok: false, reason } });
    const res = await app.inject({ method: 'POST', url: '/chaos/actions/x', payload: { turnstileToken: 'human' } });
    assert.equal(res.statusCode, code, reason);
    assert.equal(res.json().reason, reason);
  }
});

test('CORS: only the allowed origin, with a preflight', async () => {
  const { app } = make();
  const pre = await app.inject({ method: 'OPTIONS', url: '/chaos/actions/kill-pod', headers: { origin: 'https://hetops.dev' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], 'https://hetops.dev');
  const other = await app.inject({ url: '/chaos/actions', headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined);
});

test('5xx never leaks internals', async () => {
  const { app } = make({ deps: { incidents: { list: () => { throw new Error('connect ECONNREFUSED 10.96.0.1:443'); } } } });
  const res = await app.inject('/chaos/incidents');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'internal' });
});
