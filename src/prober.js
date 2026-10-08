import http from 'node:http';

// fetch() will not send a custom Host header; http.get does. We call ingress-nginx by its Service name, as lab.hetops.dev,
// so a probe takes the same path as a visitor: ingress -> Service -> pod.
export function httpFetch(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text), body: { cancel: async () => {} } });
      });
    });
    req.on('error', reject);
  });
}

// Steady synthetic traffic (5 req/s) so viewers see real request outcomes without generating load themselves.
export class Prober {
  #timers = [];
  #batch = [];
  #recent = []; // the last 10 s of results, for ok()

  constructor({ url, fetchImpl = fetch, headers, json = true, now = Date.now, intervalMs = 200, flushMs = 1000, onBatch }) {
    Object.assign(this, { url, fetchImpl, headers, json, now, intervalMs, flushMs, onBatch });
  }

  async tick() {
    const at = this.now();
    let r;
    try {
      const res = await this.fetchImpl(this.url, { headers: this.headers, signal: AbortSignal.timeout(1000) });
      let pod = null;
      if (res.ok && this.json) pod = (await res.json())?.pod ?? null;
      else await res.body?.cancel();
      r = { at, ok: res.ok, status: res.status, pod, ms: this.now() - at };
    } catch {
      r = { at, ok: false, status: 0, pod: null, ms: this.now() - at };
    }
    this.#batch.push(r);
    this.#recent.push(r);
    while (this.#recent.length && this.#recent[0].at < this.now() - 10_000) this.#recent.shift();
  }

  // Did every request in the last windowMs succeed? No data counts as no.
  ok(windowMs) {
    const recent = this.#recent.filter((r) => r.at >= this.now() - windowMs);
    return recent.length > 0 && recent.every((r) => r.ok);
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
