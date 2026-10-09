// Nightly self-test: run every experiment in turn with the bypass token, and check each one healed inside its target.
// Run by the chaos-selftest CronJob: node src/selftest.js. It talks to chaos-api like any client; no Kubernetes access.
import { ACTIONS } from './actions.js';

export async function runSelftest({ api, token, actions = ACTIONS, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {}, retryMs = 10_000, maxRetries = 30, pollMs = 5_000, maxPolls = 150 }) {
  const get = async (path) => (await fetchImpl(api + path)).json();
  const results = [];
  for (const a of actions) {
    let res, body;
    for (let i = 0; ; i++) {
      res = await fetchImpl(`${api}/chaos/actions/${a.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-chaos-bypass': token }, body: '{}',
      });
      body = await res.json();
      if (res.status !== 409 || i >= maxRetries) break; // someone else's experiment, or the lab still healing: wait
      await sleep(retryMs);
    }
    if (res.status === 503 && body.reason === 'disabled') return { aborted: 'experiments are switched off (chaos-config enabled is not "owner" or "true")', results };
    let r;
    if (res.status !== 202) {
      r = { id: a.id, ok: false, why: `refused: ${body.reason ?? res.status}` };
    } else {
      for (let i = 0; i < maxPolls && (await get('/chaos/status')).experiment; i++) await sleep(pollMs);
      const exp = (await get('/chaos/incidents')).find((e) => e.id === body.id);
      if (!exp) r = { id: a.id, ok: false, why: 'no result' };
      else if (exp.status !== 'recovered') r = { id: a.id, ok: false, why: exp.status };
      else {
        const ok = exp.recoveryMs <= a.target * 1000;
        r = { id: a.id, ok, ms: exp.recoveryMs, why: ok ? '' : `over target ${a.target} s (${Math.round(exp.recoveryMs / 1000)} s)` };
      }
    }
    results.push(r);
    log(r);
  }
  return { results };
}

// One line for the status page: green only if everything healed in time.
export function summary({ aborted, results }) {
  if (aborted) return { up: false, msg: `aborted: ${aborted}` };
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return { up: true, msg: `${results.length}/${results.length} healed inside target` };
  return { up: false, msg: bad.map((r) => `${r.id}: ${r.why}`).join('; ').slice(0, 250) };
}

if (process.argv[1]?.endsWith('selftest.js')) {
  const s = await runSelftest({
    api: process.env.CHAOS_URL ?? 'http://chaos-api.chaos.svc.cluster.local',
    token: process.env.BYPASS_TOKEN,
    log: (r) => console.log(JSON.stringify(r)),
  }).then(summary, (err) => ({ up: false, msg: `crashed: ${err.message}`.slice(0, 250) })); // report it now, not 25 h later
  console.log(JSON.stringify(s));
  if (process.env.PUSH_URL) {
    // Uptime Kuma push monitor: a missing push (the job never ran) alerts as well as a "down" one.
    const u = new URL(process.env.PUSH_URL);
    u.searchParams.set('status', s.up ? 'up' : 'down');
    u.searchParams.set('msg', s.msg);
    await fetch(u, { signal: AbortSignal.timeout(10_000) }).then((r) => r.body?.cancel(), (err) => console.error('push failed:', err.message));
  }
  process.exit(s.up ? 0 : 1);
}
