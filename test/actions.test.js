import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, findAction, makeLoad } from '../src/actions.js';

const readyPod = (name, ip) => ({ metadata: { name, labels: { app: 'api' } }, status: { podIP: ip, conditions: [{ type: 'Ready', status: 'True' }] } });

function fakeCtx() {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  const k8s = {
    listPods: async () => [readyPod('api-a', '10.0.0.1'), readyPod('api-b', '10.0.0.2')],
    listDeployments: async () => [{ metadata: { name: 'api' }, spec: { template: { spec: { containers: [{ name: 'api', image: 'ghcr.io/het101/clinic-api:66f54cc' }] } } } }],
    deletePod: rec('deletePod'), evictPod: rec('evictPod'), scaleDeployment: rec('scaleDeployment'),
    setImage: rec('setImage'), deleteDeployment: rec('deleteDeployment'), deleteService: rec('deleteService'),
    deleteSecret: rec('deleteSecret'), createNetworkPolicy: rec('createNetworkPolicy'), deleteNamespace: rec('deleteNamespace'),
  };
  const cfg = { appNamespace: 'clinic', dataNamespace: 'clinic-data', argoApp: 'clinic', internalToken: 'tok' };
  return { calls, ctx: { k8s, cfg, random: () => 0, http: rec('http'), load: rec('load') } };
}

test('the menu is exactly the 15 spec actions, two heavy', () => {
  assert.deepEqual(ACTIONS.map((a) => a.id), ['kill-pod', 'evict-api', 'delete-api-pods', 'crash', 'leak', 'hang', 'scale-zero',
    'delete-web', 'delete-api-svc', 'bad-release', 'delete-secret', 'rogue-netpol', 'kill-postgres', 'traffic-spike', 'nuke-namespace']);
  assert.deepEqual(ACTIONS.filter((a) => a.heavy).map((a) => a.id), ['traffic-spike', 'nuke-namespace']);
  assert.equal(findAction('nope'), undefined);
  assert.equal(findAction('__proto__'), undefined);
});

test('pod actions hit the right objects', async () => {
  const { calls, ctx } = fakeCtx();
  await findAction('kill-pod').run(ctx);
  await findAction('delete-api-pods').run(ctx);
  await findAction('kill-postgres').run(ctx);
  assert.deepEqual(calls, [['deletePod', 'clinic', 'api-a'], ['deletePod', 'clinic', 'api-a'], ['deletePod', 'clinic', 'api-b'], ['deletePod', 'clinic-data', 'postgres-0']]);
});

test('evictions count refusals instead of failing', async () => {
  const { ctx } = fakeCtx();
  let n = 0;
  ctx.k8s.evictPod = async () => { if (n++ > 0) throw new Error('429'); };
  assert.deepEqual(await findAction('evict-api').run(ctx), { evicted: 1, refused: 1 });
});

test('process actions call the pod internal endpoint with the token', async () => {
  const { calls, ctx } = fakeCtx();
  await findAction('leak').run(ctx);
  assert.deepEqual(calls[0], ['http', 'http://10.0.0.1:8080/internal/leak', { method: 'POST', headers: { 'x-chaos-token': 'tok' } }]);
});

test('drift actions', async () => {
  const { calls, ctx } = fakeCtx();
  for (const id of ['scale-zero', 'delete-web', 'delete-api-svc', 'delete-secret', 'bad-release', 'nuke-namespace']) await findAction(id).run(ctx);
  assert.deepEqual(calls, [
    ['scaleDeployment', 'clinic', 'web', 0], ['deleteDeployment', 'clinic', 'web'], ['deleteService', 'clinic', 'api'],
    ['deleteSecret', 'clinic', 'clinic-db'], ['setImage', 'clinic', 'api', 'api', 'ghcr.io/het101/clinic-api:bad'], ['deleteNamespace', 'clinic'],
  ]);
});

test('rogue policy carries Argo CD tracking so prune removes it', async () => {
  const { calls, ctx } = fakeCtx();
  await findAction('rogue-netpol').run(ctx);
  const [, ns, body] = calls[0];
  assert.equal(ns, 'clinic');
  assert.equal(body.metadata.name, 'chaos-deny-all');
  assert.equal(body.metadata.annotations['argocd.argoproj.io/tracking-id'], 'clinic:networking.k8s.io/NetworkPolicy:clinic/chaos-deny-all');
  assert.deepEqual(body.spec, { podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
});

test('no ready api pods: process actions fail clearly', async () => {
  const { ctx } = fakeCtx();
  ctx.k8s.listPods = async () => [];
  await assert.rejects(findAction('crash').run(ctx), /no ready api pods/);
});

test('load generator fires concurrent requests until the deadline', async () => {
  let hits = 0;
  const load = makeLoad({ url: 'http://x/api/work', concurrency: 3, fetchImpl: async () => { hits++; await new Promise((r) => setImmediate(r)); } });
  load(40);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(hits >= 3, `expected several requests, got ${hits}`);
  const after = hits;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hits, after);
});

test('load loop cancels bodies and backs off after a failure', async () => {
  let hits = 0, cancelled = 0;
  makeLoad({ url: 'u', concurrency: 1, fetchImpl: async () => { hits++; throw new Error('dns'); } })(450);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(hits <= 3, `expected back-off, got ${hits}`);
  makeLoad({ url: 'u', concurrency: 1, fetchImpl: async () => ({ body: { cancel: async () => { cancelled++; await new Promise((r) => setImmediate(r)); } } }) })(30);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cancelled > 0);
});

test('hang and traffic-spike declare a longer observation window', () => {
  assert.equal(findAction('hang').observeMs, 75_000);
  assert.equal(findAction('traffic-spike').observeMs, 100_000);
});
