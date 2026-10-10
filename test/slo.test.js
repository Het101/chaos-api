import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SloReader, QUERIES, STALE_MS } from '../src/slo.js';

const VALUES = { budget: 0.7, sli7d: 0.997, burn5m: 12.5, burn1h: 1 };
// A fake Prometheus: answers each fixed query with its value, as the HTTP API does (value: [time, "string"]).
function fakeProm({ values = VALUES, fail = false, status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (fail) throw new Error('ECONNREFUSED');
    const q = new URL(url).searchParams.get('query');
    const key = Object.keys(QUERIES).find((k) => QUERIES[k] === q);
    const result = key && values[key] !== undefined ? [{ metric: {}, value: [1, String(values[key])] }] : [];
    return { ok: status === 200, status, json: async () => ({ status: 'success', data: { resultType: 'vector', result } }) };
  };
  return { fetchImpl, urls };
}

test('reads the four SLO numbers from fixed queries', async () => {
  let t = 1_000;
  const { fetchImpl, urls } = fakeProm();
  const r = new SloReader({ url: 'http://prom:9090', fetchImpl, now: () => t });
  assert.equal(await r.poll(), true);
  assert.deepEqual(r.read(), { ...VALUES, at: 1_000 });
  assert.equal(urls.length, 4);
  for (const u of urls) assert.match(u, /^http:\/\/prom:9090\/api\/v1\/query\?query=/);
  assert.deepEqual(Object.values(QUERIES), ['lab:slo_budget_remaining', '1 - lab:visits_bad:ratio_rate7d',
    'lab:slo_burn_rate{window="5m"}', 'lab:slo_burn_rate{window="1h"}']);
});

test('unknown until the first good read, and again once the last one is stale', async () => {
  let t = 0;
  const r = new SloReader({ url: 'http://p', fetchImpl: fakeProm().fetchImpl, now: () => t });
  assert.equal(r.read(), null);
  await r.poll();
  t += STALE_MS;
  assert.notEqual(r.read(), null);
  t += 1;
  assert.equal(r.read(), null);
});

test('a failed poll keeps the last good reading (until it goes stale)', async () => {
  let t = 0;
  let fail = false;
  const good = fakeProm().fetchImpl;
  const r = new SloReader({ url: 'http://p', fetchImpl: (u) => (fail ? Promise.reject(new Error('down')) : good(u)), now: () => t });
  await r.poll();
  fail = true;
  t += 30_000;
  assert.equal(await r.poll(), false);
  assert.equal(r.read().budget, 0.7);
});

test('all four or nothing: a missing series or HTTP error is a failed poll', async () => {
  const r1 = new SloReader({ url: 'http://p', fetchImpl: fakeProm({ values: { budget: 0.7 } }).fetchImpl });
  assert.equal(await r1.poll(), false);
  assert.equal(r1.read(), null);
  const r2 = new SloReader({ url: 'http://p', fetchImpl: fakeProm({ status: 503 }).fetchImpl });
  assert.equal(await r2.poll(), false);
  const r3 = new SloReader({ url: 'http://p', fetchImpl: fakeProm({ values: { ...VALUES, sli7d: 'NaN' } }).fetchImpl });
  assert.equal(await r3.poll(), false);
});
