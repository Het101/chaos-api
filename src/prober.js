// Steady synthetic traffic (5 req/s) so viewers see real request outcomes without generating load themselves.
export class Prober {
  #timers = [];
  #batch = [];

  constructor({ url, fetchImpl = fetch, now = Date.now, intervalMs = 200, flushMs = 1000, onBatch }) {
    Object.assign(this, { url, fetchImpl, now, intervalMs, flushMs, onBatch });
  }

  async tick() {
    const at = this.now();
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(1000) });
      const body = res.ok ? await res.json() : null;
      if (!res.ok) await res.body?.cancel();
      this.#batch.push({ at, ok: res.ok, status: res.status, pod: body?.pod ?? null, ms: this.now() - at });
    } catch {
      this.#batch.push({ at, ok: false, status: 0, pod: null, ms: this.now() - at });
    }
  }

  flush() {
    if (!this.#batch.length) return;
    const batch = this.#batch;
    this.#batch = [];
    this.onBatch(batch);
  }

  start() {
    this.#timers = [setInterval(() => this.tick(), this.intervalMs), setInterval(() => this.flush(), this.flushMs)];
  }

  stop() { this.#timers.forEach(clearInterval); }
}
