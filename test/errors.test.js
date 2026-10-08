import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, withTimeout } from '../src/errors.js';
import { checkHealth } from '../src/health.js';
import { takeSnapshot } from '../src/snapshot.js';

const secret = 'User "system:serviceaccount:chaos:chaos-api" cannot list pods audit-id=abc';
const apiErr = (code) => Object.assign(new Error(secret), { code });

test('brief never leaks the message', () => {
  assert.equal(brief(apiErr(403)), 'HTTP 403');
  assert.equal(brief(Object.assign(new Error('x'), { statusCode: 500 })), 'HTTP 500');
  assert.equal(brief(Object.assign(new Error(secret), { code: 'ECONNREFUSED' })), 'unreachable');
  assert.equal(brief(new Error(secret)), 'unreachable');
});

test('withTimeout rejects a hung promise and passes results through', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'slow'), /slow timed out/);
  assert.equal(await withTimeout(Promise.resolve(7), 20, 'ok'), 7);
});

test('health reasons carry no Kubernetes text', async () => {
  const cfg = { appNamespace: 'clinic', dataNamespace: 'clinic-data', argoNamespace: 'argocd', argoApp: 'clinic' };
  const boom = async () => { throw apiErr(403); };
  const h = await checkHealth({ listDeployments: boom, listPods: boom, getArgoApp: boom }, cfg);
  assert.deepEqual(h.reasons, ['clinic: HTTP 403', 'postgres: HTTP 403', 'argo: HTTP 403']);
});

test('snapshot errors are brief, so consecutive snapshots are identical', async () => {
  const cfg = { appNamespace: 'clinic', dataNamespace: 'clinic-data', argoNamespace: 'argocd', argoApp: 'clinic' };
  let n = 0;
  const boom = async () => { throw apiErr(403 + 0 * n++); };
  const k8s = { listPods: boom, listDeployments: boom, getArgoApp: async () => { throw Object.assign(new Error(`audit-id=${n++}`), { code: 403 }); } };
  const a = JSON.stringify(await takeSnapshot(k8s, cfg));
  assert.equal(a, JSON.stringify(await takeSnapshot(k8s, cfg)));
  assert.ok(!a.includes('serviceaccount'));
  assert.ok(a.includes('HTTP 403'));
});
