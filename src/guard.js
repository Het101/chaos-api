const HOUR = 3_600_000;

// The safety rails: one experiment at a time, a cooldown per visitor, an hourly cap on heavy actions.
export class Guard {
  #running = null;
  #lastByIp = new Map();
  #heavy = [];

  constructor({ now = Date.now, cooldownMs = 60_000, heavyPerHour = 3 } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.heavyPerHour = heavyPerHour;
  }

  get running() { return this.#running; }

  check({ ipHash, heavy = false, enabled, healthy, memoryOk, bypass = false, frozen = false }) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (this.#running) return { ok: false, reason: 'busy' };
    if (!healthy) return { ok: false, reason: 'healing' };
    if (!memoryOk) return { ok: false, reason: 'node-memory' };
    if (bypass) return { ok: true };
    if (frozen) return { ok: false, reason: 'budget-spent' }; // the error budget policy; bypass (owner, self-test) is exempt
    const t = this.now();
    const last = this.#lastByIp.get(ipHash);
    if (last !== undefined && t - last < this.cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterMs: this.cooldownMs - (t - last) };
    }
    if (heavy) {
      this.#heavy = this.#heavy.filter((x) => t - x < HOUR);
      if (this.#heavy.length >= this.heavyPerHour) {
        return { ok: false, reason: 'hourly-cap', retryAfterMs: HOUR - (t - this.#heavy[0]) };
      }
    }
    return { ok: true };
  }

  begin({ ipHash, heavy = false, bypass = false, experiment }) {
    this.#running = experiment;
    if (bypass) return;
    const t = this.now();
    for (const [k, v] of this.#lastByIp) if (t - v >= this.cooldownMs) this.#lastByIp.delete(k); // keep the map small
    this.#lastByIp.set(ipHash, t);
    if (heavy) this.#heavy.push(t);
  }

  end() { this.#running = null; }
}
