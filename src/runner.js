import { randomUUID } from 'node:crypto';
import { findAction } from './actions.js';
import { brief, withTimeout } from './errors.js';

// Starts one experiment, then watches the lab until it is healthy again (or times out).
export class Runner {
  constructor({ cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx,
    now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, minObserveMs = 15_000, callMs = 10_000, runMs = 30_000, log = () => {} }) {
    Object.assign(this, { cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx, now, sleep, pollMs, minObserveMs, callMs, runMs, log });
    this.observing = Promise.resolve();
  }

  async start({ actionId, ipHash, bypass = false }) {
    const action = findAction(actionId);
    if (!action) return { ok: false, reason: 'unknown-action' };
    const [enabled, h, memoryOk] = await Promise.all([
      withTimeout(this.readEnabled(), this.callMs, 'readEnabled'), withTimeout(this.health(), this.callMs, 'health'), withTimeout(this.memory(), this.callMs, 'memory'),
    ]);
    const verdict = this.guard.check({ ipHash, heavy: action.heavy, enabled, healthy: h.healthy, memoryOk, bypass });
    if (!verdict.ok) return { ...verdict, reasons: h.reasons };

    const exp = { id: randomUUID(), action: action.id, title: action.title, startedAt: this.now(), ipHash, status: 'running' };
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
    this.observing = this.#observe(exp, action); // recovery is watched in the background
    return { ok: true, experiment: started };
  }

  async #observe(exp, action) {
    const minMs = Math.max(this.minObserveMs, action.observeMs ?? 0);
    let sawBreak = false;
    try {
      for (;;) {
        await this.sleep(this.pollMs);
        // A hung health call counts as unhealthy, and elapsed is read after it: the timeout is wall-clock.
        const h = await withTimeout(this.health(), this.callMs, 'health').catch((err) => ({ healthy: false, reasons: [brief(err)] }));
        const elapsed = this.now() - exp.startedAt;
        if (!h.healthy) sawBreak = true;
        // Some breakage takes seconds to show; never declare recovery before it could have been seen.
        if (h.healthy && (sawBreak || elapsed >= minMs)) { exp.status = 'recovered'; exp.recoveryMs = elapsed; break; }
        if (elapsed >= this.cfg.experimentTimeoutMs) { exp.status = 'timeout'; exp.reasons = h.reasons; break; }
      }
    } catch (err) {
      exp.status = 'error';
      exp.error = brief(err);
    }
    this.#finish(exp);
  }

  #finish(exp) {
    exp.endedAt = this.now();
    this.guard.end();
    this.incidents.add(exp);
    this.broadcast('experiment', { ...exp });
  }
}
