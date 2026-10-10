import { randomUUID } from 'node:crypto';
import { findAction } from './actions.js';
import { brief, withTimeout } from './errors.js';

// The kill switch: "true" = everyone, "owner" = bypass requests only (game day, self-test), anything else = off.
export const switchAllows = (mode, bypass) => mode === true || mode === 'true' || (mode === 'owner' && bypass);

// The 99% / 7-day SLO allows 1% bad visits: 5 visits/s x 604,800 s x 1% = 30,240 bad visits a week.
export const WEEKLY_BAD_VISITS = 30_240;

// Starts one experiment, then watches the lab until it is healthy again (or times out).
export class Runner {
  constructor({ cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx,
    now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, minObserveMs = 15_000, callMs = 10_000, runMs = 30_000, log = () => {}, userOk = () => true, metrics = null, frozen = () => false, badVisits = () => 0 }) {
    Object.assign(this, { cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx, now, sleep, pollMs, minObserveMs, callMs, runMs, log, userOk, metrics, frozen, badVisits });
    this.observing = Promise.resolve();
  }

  async start({ actionId, ipHash, bypass = false }) {
    const action = findAction(actionId);
    if (!action) return { ok: false, reason: 'unknown-action' };
    const [enabled, h, memoryOk] = await Promise.all([
      withTimeout(this.readEnabled(), this.callMs, 'readEnabled'), withTimeout(this.health(), this.callMs, 'health'), withTimeout(this.memory(), this.callMs, 'memory'),
    ]);
    const verdict = this.guard.check({ ipHash, heavy: action.heavy, enabled: switchAllows(enabled, bypass), healthy: h.healthy, memoryOk, bypass, frozen: this.frozen() });
    if (!verdict.ok) return { ...verdict, reasons: h.reasons };

    const exp = { id: randomUUID(), action: action.id, title: action.title, startedAt: this.now(), ipHash, status: 'running' };
    const bad0 = this.badVisits();
    this.guard.begin({ ipHash, heavy: action.heavy, bypass, experiment: exp });
    this.broadcast('experiment', { ...exp });
    try {
      exp.detail = await withTimeout(action.run(this.ctx), this.runMs, 'action');
    } catch (err) {
      // It may have half-done its damage: keep the lock and watch recovery like any other experiment.
      this.log(err, 'action failed');
      exp.status = 'action-failed';
      exp.error = brief(err);
      this.broadcast('experiment', { ...exp });
    }
    const started = { ...exp };
    this.observing = this.#observe(exp, action, bad0); // recovery is watched in the background
    return { ok: true, experiment: started };
  }

  async #observe(exp, action, bad0) {
    let sawBreak = false;
    try {
      for (;;) {
        await this.sleep(this.pollMs);
        // A hung health call counts as unhealthy, and elapsed is read after it: the timeout is wall-clock.
        const h = await withTimeout(this.health(), this.callMs, 'health').catch((err) => ({ healthy: false, reasons: [brief(err)] }));
        const elapsed = this.now() - exp.startedAt;
        // Recovered means users are served again, not just that the pods look fine.
        const users = this.userOk();
        if (!h.healthy || !users) sawBreak = true;
        // Never before the action has finished its own work (traffic-spike), nor before breakage could have shown.
        const settled = elapsed >= (action.observeMs ?? 0) && (sawBreak || elapsed >= this.minObserveMs);
        if (h.healthy && users && settled) { exp.status = 'recovered'; exp.recoveryMs = elapsed; break; }
        if (elapsed >= this.cfg.experimentTimeoutMs) { exp.status = 'timeout'; exp.reasons = h.reasons; break; }
      }
    } catch (err) {
      exp.status = 'error';
      exp.error = brief(err);
    }
    this.#finish(exp, bad0);
  }

  #finish(exp, bad0) {
    this.guard.end();
    exp.endedAt = this.now();
    exp.cost = Math.max(0, this.badVisits() - bad0) / WEEKLY_BAD_VISITS; // what this experiment spent of the weekly budget
    this.incidents.add(exp);
    this.broadcast('experiment', { ...exp });
    this.metrics?.experiments.inc({ action: exp.action, status: exp.status });
    if (exp.status === 'recovered') this.metrics?.recovery.observe({ action: exp.action }, exp.recoveryMs / 1000);
  }
}
