import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

// A dedicated registry (not the global one) so tests and instances never share state.
export function createMetrics() {
  const register = new Registry();
  collectDefaultMetrics({ register });
  const experiments = new Counter({ name: 'chaos_experiments_total', help: 'Finished experiments by action and final status.', labelNames: ['action', 'status'], registers: [register] });
  const recovery = new Histogram({ name: 'chaos_recovery_seconds', help: 'Time to recover, for recovered experiments only.', labelNames: ['action'],
    buckets: [5, 10, 20, 30, 60, 90, 120, 180, 300, 600], registers: [register] });
  const probes = new Counter({ name: 'chaos_probe_requests_total', help: 'Synthetic probe requests by tier and result.', labelNames: ['tier', 'result'], registers: [register] });
  return { register, experiments, recovery, probes };
}

// One visit entry from the Prober: the api tier always, the web tier when the visit included the page.
export function countProbe(probes, entry) {
  probes.inc({ tier: 'api', result: entry.ok ? 'ok' : 'fail' });
  if (entry.web) probes.inc({ tier: 'web', result: entry.web.ok ? 'ok' : 'fail' });
}
