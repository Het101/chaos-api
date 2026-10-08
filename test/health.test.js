import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, checkMemory } from '../src/health.js';

const cfg = { appNamespace: 'clinic', dataNamespace: 'clinic-data', argoNamespace: 'argocd', argoApp: 'clinic', nodeMemoryBytes: 1000, memoryThreshold: 0.8 };
const dep = (name, want, have) => ({ metadata: { name }, spec: { replicas: want }, status: { availableReplicas: have } });
const ready = { metadata: { name: 'postgres-0' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } };
const k8s = (over = {}) => ({
  listDeployments: async () => [dep('api', 3, 3), dep('web', 2, 2), dep('worker', 1, 1)],
  listPods: async () => [ready],
  getArgoApp: async () => ({ status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } }),
  nodeMemoryUsedBytes: async () => 500,
  ...over,
});

test('healthy when everything is available, Postgres is ready and Argo CD is green', async () => {
  assert.deepEqual(await checkHealth(k8s(), cfg), { healthy: true, reasons: [] });
});

test('lists every reason it is not healthy', async () => {
  const h = await checkHealth(k8s({
    listDeployments: async () => [dep('api', 3, 1), dep('worker', 0, 0)],
    listPods: async () => [],
    getArgoApp: async () => ({ status: { sync: { status: 'OutOfSync' }, health: { status: 'Progressing' } } }),
  }), cfg);
  assert.equal(h.healthy, false);
  assert.deepEqual(h.reasons, ['api: 1/3 available', 'web: missing', 'worker: 0/0 available', 'postgres: not ready', 'argo: OutOfSync/Progressing']);
});

test('a deleted namespace is unhealthy, not a crash', async () => {
  const h = await checkHealth(k8s({ listDeployments: async () => { throw Object.assign(new Error('namespaces "clinic" not found'), { code: 404 }); } }), cfg);
  assert.equal(h.healthy, false);
  assert.equal(h.reasons[0], 'clinic: HTTP 404');
});

test('memory gate: under the threshold only, and fails closed', async () => {
  assert.equal(await checkMemory(k8s(), cfg), true);
  assert.equal(await checkMemory(k8s({ nodeMemoryUsedBytes: async () => 800 }), cfg), false);
  assert.equal(await checkMemory(k8s({ nodeMemoryUsedBytes: async () => { throw new Error('no metrics'); } }), cfg), false);
});
