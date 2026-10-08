import { randomUUID } from 'node:crypto';
import { findAction } from './actions.js';

// Starts one experiment, then watches the lab until it is healthy again (or times out).
export class Runner {
  constructor({ cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx,
    now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, minObserveMs = 15_000 }) {
    Object.assign(this, { cfg, guard, incidents, broadcast, health, memory, readEnabled, ctx, now, sleep, pollMs, minObserveMs });
    this.observing = Promise.resolve();
  }

  async start({ actionId, ipHash, bypass = false }) {
    const action = findAction(actionId);
    if (!action) return { ok: false, reason: 'unknown-action' };
    const [enabled, h, memoryOk] = await Promise.all([this.readEnabled(), this.health(), this.memory()]);
    const verdict = this.guard.check({ ipHash, heavy: action.heavy, enabled, healthy: h.healthy, memoryOk, bypass });
    if (!verdict.ok) return { ...verdict, reasons: h.reasons };

    const exp = { id: randomUUID(), action: action.id, title: action.title, startedAt: this.now(), ipHash, status: 'running' };
    this.guard.begin({ ipHash, heavy: action.heavy, bypass, experiment: exp });
    this.broadcast('experiment', { ...exp });
    try {
      exp.detail = await action.run(this.ctx);
    } catch (err) {
      exp.status = 'action-failed';
      exp.error = err.message;
      this.#finish(exp);
      return { ok: true, experiment: exp };
    }
    this.observing = this.#observe(exp); // recovery is watched in the background
    return { ok: true, experiment: exp };
  }

  async #observe(exp) {
    let sawBreak = false;
    try {
      for (;;) {
        await this.sleep(this.pollMs);
        const elapsed = this.now() - exp.startedAt;
        const h = await this.health();
        if (!h.healthy) sawBreak = true;
        // Some breakage takes seconds to show; never declare recovery before it could have been seen.
        if (h.healthy && (sawBreak || elapsed >= this.minObserveMs)) { exp.status = 'recovered'; exp.recoveryMs = elapsed; break; }
        if (elapsed >= this.cfg.experimentTimeoutMs) { exp.status = 'timeout'; exp.reasons = h.reasons; break; }
      }
    } catch (err) {
      exp.status = 'error';
      exp.error = err.message;
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
