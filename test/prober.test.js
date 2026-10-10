import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prober } from '../src/prober.js';

test('counts bad visits: a failed page or a failed api call', async () => {
  const answers = [{ ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: true }, { ok: false }];
  const fetchImpl = async () => { const a = answers.shift(); return { ok: a.ok, status: a.ok ? 200 : 503, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } }; };
  const p = new Prober({ url: 'http://x/api', webUrl: 'http://x/', fetchImpl, onBatch: () => {} });
  await p.tick(); // page ok, api ok
  await p.tick(); // page bad, api ok
  await p.tick(); // page ok, api bad
  assert.equal(p.bad, 2);
});
