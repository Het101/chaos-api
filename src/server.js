import { loadConfig } from './config.js';
import { createK8s } from './k8s.js';
import { Guard } from './guard.js';
import { IncidentLog } from './incidents.js';
import { Runner } from './runner.js';
import { Stream } from './stream.js';
import { Prober } from './prober.js';
import { takeSnapshot } from './snapshot.js';
import { checkHealth, checkMemory } from './health.js';
import { verifyTurnstile } from './turnstile.js';
import { makeLoad } from './actions.js';
import { buildApp } from './app.js';
import { withTimeout } from './errors.js';

const cfg = loadConfig();
const k8s = createK8s();
const stream = new Stream();

const incidents = new IncidentLog({ save: (items) => k8s.patchConfigMap(cfg.selfNamespace, 'chaos-incidents', { incidents: JSON.stringify(items) }) });
try {
  const cm = await k8s.readConfigMap(cfg.selfNamespace, 'chaos-incidents');
  incidents.load(JSON.parse(cm.data?.incidents ?? '[]'));
} catch { /* first start, or unreadable: begin with an empty log */ }

const http = async (url, opts) => {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(3000) });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

const runner = new Runner({
  cfg,
  guard: new Guard({ cooldownMs: cfg.cooldownMs, heavyPerHour: cfg.heavyPerHour }),
  incidents,
  broadcast: (event, data) => stream.broadcast(event, data),
  health: () => checkHealth(k8s, cfg),
  memory: () => checkMemory(k8s, cfg),
  readEnabled: async () => {
    try { return (await k8s.readConfigMap(cfg.selfNamespace, 'chaos-config')).data?.enabled === 'true'; } catch { return false; }
  },
  log: (err, msg) => app.log.warn({ err: err.message }, msg),
  ctx: { k8s, cfg, http, random: Math.random, load: makeLoad({ url: cfg.loadUrl }) },
});

let latest = null;
let latestJson = '';
let refreshing = false;
const app = buildApp({ cfg, runner, stream, incidents, verifyTurnstile, latestSnapshot: () => latest });

const refresh = async () => {
  if (refreshing) return; // never overlap: a slow API server must not pile up requests
  refreshing = true;
  try {
    const snap = await withTimeout(takeSnapshot(k8s, cfg), 10_000, 'snapshot');
    const json = JSON.stringify(snap);
    if (json !== latestJson) {
      latestJson = json;
      latest = { at: Date.now(), ...snap };
      stream.broadcast('snapshot', latest);
    }
  } catch (err) {
    app.log.warn({ err: err.message }, 'snapshot failed');
  } finally {
    refreshing = false;
  }
};

const prober = new Prober({ url: cfg.probeUrl, onBatch: (batch) => stream.broadcast('probes', batch) });
const timers = [setInterval(refresh, 1000), setInterval(() => stream.heartbeat(), 15_000)];
prober.start();

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try {
    prober.stop();
    timers.forEach(clearInterval);
    stream.closeAll(); // open SSE sockets are never idle, so close() would wait on them
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err: err.message }, 'shutdown failed');
    process.exit(1);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
