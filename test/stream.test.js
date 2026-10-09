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

test('SSE: capped at 200 clients, slow readers are dropped, closeAll ends everyone', () => {
  const s = new Stream();
  for (let i = 0; i < 200; i++) s.add(new FakeRes());
  assert.equal(s.full, true);
  assert.equal(s.add(new FakeRes()), false);
  assert.equal(s.size, 200);
  const slow = new FakeRes();
  slow.writableLength = 300 * 1024;
  slow.destroy = () => { slow.destroyed = true; };
  const s2 = new Stream();
  const ok = new FakeRes();
  s2.add(ok); s2.add(slow);
  s2.broadcast('x', {});
  assert.equal(slow.destroyed, true);
  assert.equal(s2.size, 1);
  ok.ended = false; ok.end = () => { ok.ended = true; };
  s2.closeAll();
  assert.equal(ok.ended, true);
  assert.equal(s2.size, 0);
});

test('prober cancels the body of a non-ok response', async () => {
  let cancelled = 0;
  const p = new Prober({ url: 'u', onBatch() {}, fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => { cancelled++; } } }) });
  await p.tick();
  assert.equal(cancelled, 1);
});

test('prober remembers recent results: ok() is true only if every request in the window succeeded', async () => {
  let t = 0, fail = false;
  const p = new Prober({ url: 'u', onBatch() {}, now: () => t, fetchImpl: async () => (fail ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({ pod: 'api-a' }) }) });
  assert.equal(p.ok(4000), false, 'no data yet is not ok');
  await p.tick();
  assert.equal(p.ok(4000), true);
  t = 1000; fail = true; await p.tick();
  assert.equal(p.ok(4000), false);
  t = 6000; fail = false; await p.tick();
  assert.equal(p.ok(4000), true, 'the failure at 1 s is outside the 4 s window');
});

test('a non-JSON target (the web page) counts a 200 as ok without parsing it', async () => {
  const batches = [];
  const p = new Prober({ url: 'u', json: false, now: () => 5, onBatch: (b) => batches.push(b), fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); }, body: { cancel: async () => {} } }) });
  await p.tick(); p.flush();
  assert.deepEqual(batches[0], [{ at: 5, ok: true, status: 200, pod: null, ms: 0 }]);
});

// A response as httpFetch returns it: status, x-pod header, optional JSON body.
const reply = (status, pod, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (k === 'x-pod' ? pod : null) }, json: async () => body, body: { cancel: async () => {} } });

test('a visit is the page from a web pod, then /api from an api pod, both named', async () => {
  const batches = [];
  const p = new Prober({ url: 'api', webUrl: 'web', now: () => 7, onBatch: (b) => batches.push(b),
    fetchImpl: async (url) => (url === 'web' ? reply(200, 'web-1') : reply(200, 'api-2', { pod: 'api-2' })) });
  await p.tick(); p.flush();
  assert.deepEqual(batches[0], [{ at: 7, ok: true, status: 200, pod: 'api-2', ms: 0, web: { ok: true, pod: 'web-1' } }]);
});

test('database down: the api pod still answers (named by its header) but the hop fails', async () => {
  const batches = [];
  const p = new Prober({ url: 'api', webUrl: 'web', now: () => 7, onBatch: (b) => batches.push(b),
    fetchImpl: async (url) => (url === 'web' ? reply(200, 'web-1') : reply(500, 'api-2', { error: 'internal' })) });
  await p.tick(); p.flush();
  assert.deepEqual(batches[0][0], { at: 7, ok: false, status: 500, pod: 'api-2', ms: 0, web: { ok: true, pod: 'web-1' } });
});

test('users are only ok when both the page and the api work', async () => {
  let webUp = false;
  const p = new Prober({ url: 'api', webUrl: 'web', now: () => 0, onBatch() {},
    fetchImpl: async (url) => (url === 'web' ? reply(webUp ? 200 : 503, null) : reply(200, 'api-1', { pod: 'api-1' })) });
  await p.tick();
  assert.equal(p.ok(4000), false, 'api fine but the page is down');
});
