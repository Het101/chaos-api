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
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
          json: async () => JSON.parse(text), body: { cancel: async () => {} } });
      });
    });
    req.on('error', reject);
  });
}

// Steady synthetic traffic (5 visits/s) so viewers see real request outcomes without generating load themselves.
// With webUrl, each tick is a visitor's visit: the page from a web pod, then /api from an api pod (which reads postgres).
export class Prober {
  #timers = [];
  #batch = [];
  #recent = []; // the last 10 s of results, for ok()

  constructor({ url, webUrl, fetchImpl = fetch, headers, json = true, now = Date.now, intervalMs = 200, flushMs = 1000, onBatch }) {
    Object.assign(this, { url, webUrl, fetchImpl, headers, json, now, intervalMs, flushMs, onBatch });
  }

  // One request; the pod is named by its X-Pod header (errors too), or by a JSON body's pod field.
  async #hit(url, json) {
    try {
      const res = await this.fetchImpl(url, { headers: this.headers, signal: AbortSignal.timeout(1000) });
      let pod = res.headers?.get?.('x-pod') ?? null;
      if (res.ok && json) pod = (await res.json())?.pod ?? pod;
      else await res.body?.cancel();
      return { ok: res.ok, status: res.status, pod };
    } catch {
      return { ok: false, status: 0, pod: null };
    }
  }

  async tick() {
    const at = this.now();
    const web = this.webUrl ? await this.#hit(this.webUrl, false) : null;
    const api = await this.#hit(this.url, this.json);
    const r = { at, ...api, ms: this.now() - at };
    if (web) r.web = { ok: web.ok, pod: web.pod };
    this.#batch.push(r);
    this.#recent.push(r);
    while (this.#recent.length && this.#recent[0].at < this.now() - 10_000) this.#recent.shift();
  }

  // Did every request in the last windowMs succeed? No data counts as no.
  ok(windowMs) {
    const recent = this.#recent.filter((r) => r.at >= this.now() - windowMs);
    return recent.length > 0 && recent.every((r) => r.ok && (r.web?.ok ?? true)); // a visit is fine only if page and api both were
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
