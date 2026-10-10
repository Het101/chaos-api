import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// A dedicated registry (not the global one) so tests and instances never share state.
export function createMetrics() {
  const register = new Registry();
  collectDefaultMetrics({ register });
  const experiments = new Counter({ name: 'chaos_experiments_total', help: 'Finished experiments by action and final status.', labelNames: ['action', 'status'], registers: [register] });
  const recovery = new Histogram({ name: 'chaos_recovery_seconds', help: 'Time to recover, for recovered experiments only.', labelNames: ['action'],
    buckets: [5, 10, 20, 30, 60, 90, 120, 180, 300, 600], registers: [register] });
  const probes = new Counter({ name: 'chaos_probe_requests_total', help: 'Synthetic probe requests by tier and result.', labelNames: ['tier', 'result'], registers: [register] });
  // The SLI: a visit is good only if the page and /api both answered in time (the prober's 1 s timeout).
  const visits = new Counter({ name: 'chaos_visits_total', help: 'Synthetic visits (page, then /api), good or bad.', labelNames: ['result'], registers: [register] });
  visits.inc({ result: 'good' }, 0); // both series exist from the start: "no bad visits yet" reads 0, not absent
  visits.inc({ result: 'bad' }, 0);
  const frozen = new Gauge({ name: 'chaos_frozen', help: '1 while the error budget policy has frozen visitor chaos.', registers: [register] });
  frozen.set(0);
  return { register, experiments, recovery, probes, visits, frozen };
}

// One visit entry from the Prober: the api tier always, the web tier when the visit included the page.
export function countProbe(probes, entry) {
  probes.inc({ tier: 'api', result: entry.ok ? 'ok' : 'fail' });
  if (entry.web) probes.inc({ tier: 'web', result: entry.web.ok ? 'ok' : 'fail' });
}

export function countVisit(visits, entry) {
  const good = entry.ok && (entry.web ? entry.web.ok : true);
  visits.inc({ result: good ? 'good' : 'bad' });
}
