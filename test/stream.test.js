import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Stream } from '../src/stream.js';
import { Prober } from '../src/prober.js';
import { takeSnapshot } from '../src/snapshot.js';

class FakeRes extends EventEmitter {
  chunks = []; headers = null;
  writeHead(code, headers) { this.code = code; this.headers = headers; }
  write(c) { this.chunks.push(c); }
}

test('SSE: headers, named events, and clients removed on close', () => {
  const s = new Stream();
  const a = new FakeRes(), b = new FakeRes();
  s.add(a, { 'access-control-allow-origin': 'https://hetops.dev' });
  s.add(b);
  assert.equal(a.headers['content-type'], 'text/event-stream');
  assert.equal(a.headers['access-control-allow-origin'], 'https://hetops.dev');
  s.broadcast('snapshot', { x: 1 });
  assert.equal(a.chunks.at(-1), 'event: snapshot\ndata: {"x":1}\n\n');
  b.emit('close');
  assert.equal(s.size, 1);
});

test('prober batches results, including failures', async () => {
  const batches = [];
  let n = 0;
  const p = new Prober({
    url: 'http://api/whoami', now: () => 100, onBatch: (b) => batches.push(b),
    fetchImpl: async () => { if (n++ === 1) throw new Error('refused'); return { ok: true, status: 200, json: async () => ({ pod: 'api-x' }) }; },
  });
  await p.tick(); await p.tick();
  p.flush(); p.flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{ at: 100, ok: true, status: 200, pod: 'api-x', ms: 0 }, { at: 100, ok: false, status: 0, pod: null, ms: 0 }]);
});

test('snapshot survives a deleted namespace and reports Argo CD', async () => {
  const cfg = { appNamespace: 'clinic', dataNamespace: 'clinic-data', argoNamespace: 'argocd', argoApp: 'clinic' };
  const k8s = {
    listPods: async (ns) => { if (ns === 'clinic') throw new Error('not found'); return [{ metadata: { name: 'postgres-0', labels: { app: 'postgres' } }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }]; },
    listDeployments: async () => [],
    getArgoApp: async () => ({ status: { sync: { status: 'OutOfSync' }, health: { status: 'Missing' }, operationState: { phase: 'Running' } } }),
  };
  const s = await takeSnapshot(k8s, cfg);
  assert.equal(s.clinic.exists, false);
  assert.equal(s['clinic-data'].pods[0].name, 'postgres-0');
  assert.deepEqual(s.argo, { sync: 'OutOfSync', health: 'Missing', operation: 'Running' });
});
