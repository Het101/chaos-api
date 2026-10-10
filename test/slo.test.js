import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SloReader, QUERIES, STALE_MS, BudgetPolicy, parseThresholds, DEFAULTS } from '../src/slo.js';

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

// A reader whose next reading the test sets directly.
const stubReader = () => { const r = { value: null, async poll() {}, read() { return r.value; } }; return r; };
const reading = (budget) => ({ budget, sli7d: 1 - (1 - budget) * 0.01, burn5m: 0, burn1h: 0, at: 0 });

test('freezes at 0, stays frozen until 5% is back, reopens at 5%', async () => {
  const reader = stubReader();
  const events = [];
  const p = new BudgetPolicy({ reader, broadcast: (e, d) => events.push([e, d && d.frozen]) });
  reader.value = reading(0.3); await p.tick(); assert.equal(p.frozen, false);
  reader.value = reading(0); await p.tick(); assert.equal(p.frozen, true);
  reader.value = reading(0.03); await p.tick(); assert.equal(p.frozen, true);
  reader.value = reading(0.05); await p.tick(); assert.equal(p.frozen, false);
  assert.deepEqual(events.map((e) => e[1]), [false, true, true, false]);
  assert.deepEqual(events.map((e) => e[0]), ['slo', 'slo', 'slo', 'slo']);
});

test('unknown SLO fails open: never frozen, state null', async () => {
  const reader = stubReader();
  const p = new BudgetPolicy({ reader });
  reader.value = reading(-0.2); await p.tick(); assert.equal(p.frozen, true);
  reader.value = null; await p.tick();
  assert.equal(p.frozen, false);
  assert.equal(p.state, null);
});

test('state carries the four numbers and the freeze, and sets the gauge', async () => {
  const reader = stubReader();
  const set = [];
  const p = new BudgetPolicy({ reader, gauge: { set: (v) => set.push(v) } });
  reader.value = { budget: 0.7, sli7d: 0.997, burn5m: 12.5, burn1h: 1, at: 5 };
  await p.tick();
  assert.deepEqual(p.state, { budget: 0.7, sli7d: 0.997, burn5m: 12.5, burn1h: 1, frozen: false });
  assert.deepEqual(set, [0]);
});

test('thresholds come from chaos-config, with defaults; a broken read uses the defaults', async () => {
  assert.deepEqual(parseThresholds(undefined), DEFAULTS);
  assert.deepEqual(parseThresholds({ enabled: 'true' }), { freezeAt: 0, reopenAt: 0.05 });
  assert.deepEqual(parseThresholds({ FREEZE_AT: '0.9', REOPEN_AT: '0.95' }), { freezeAt: 0.9, reopenAt: 0.95 });
  assert.deepEqual(parseThresholds({ FREEZE_AT: 'abc', REOPEN_AT: '' }), DEFAULTS);
  const reader = stubReader();
  reader.value = reading(0.7);
  const raised = new BudgetPolicy({ reader, readThresholds: async () => ({ freezeAt: 0.9, reopenAt: 0.95 }) });
  await raised.tick(); assert.equal(raised.frozen, true);
  const broken = new BudgetPolicy({ reader, readThresholds: async () => { throw new Error('api down'); } });
  await broken.tick(); assert.equal(broken.frozen, false);
});

test('a hung threshold read times out to the defaults; a tick never overlaps another', async () => {
  let polls = 0;
  const reader = { async poll() { polls++; }, read: () => reading(0.3) };
  const p = new BudgetPolicy({ reader, readThresholds: () => new Promise(() => {}), thresholdsMs: 20 });
  await p.tick();
  assert.equal(polls, 1);
  assert.equal(p.frozen, false);
  await Promise.all([p.tick(), p.tick()]);
  assert.equal(polls, 2);
});

test('a failed poll records why; a good poll clears it', async () => {
  const bad = new SloReader({ url: 'http://prom', fetchImpl: fakeProm({ fail: true }).fetchImpl });
  assert.equal(await bad.poll(), false);
  assert.equal(bad.lastError, 'ECONNREFUSED');
  const good = new SloReader({ url: 'http://prom', fetchImpl: fakeProm().fetchImpl });
  good.lastError = 'old';
  await good.poll();
  assert.equal(good.lastError, null);
});
