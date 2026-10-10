// The lab's SLO, read from Prometheus. The SLO itself is defined once, in the recording rules (hetops-k8s-lab,
// platform/monitoring/extras/slo-rules.yaml); chaos-api only reads it. The queries are constants: no request data
// ever reaches Prometheus.
export const QUERIES = {
  budget: 'lab:slo_budget_remaining',
  sli7d: '1 - lab:visits_bad:ratio_rate7d',
  burn5m: 'lab:slo_burn_rate{window="5m"}',
  burn1h: 'lab:slo_burn_rate{window="1h"}',
};
export const STALE_MS = 120_000;

export class SloReader {
  #last = null;

  constructor({ url, fetchImpl = fetch, now = Date.now, timeoutMs = 3000 }) {
    Object.assign(this, { url, fetchImpl, now, timeoutMs });
  }

  async #query(q) {
    const res = await this.fetchImpl(`${this.url}/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`prometheus HTTP ${res.status}`);
    const v = Number((await res.json())?.data?.result?.[0]?.value?.[1]);
    if (!Number.isFinite(v)) throw new Error(`no value for ${q}`);
    return v;
  }

  // All four or nothing: a half-updated reading would mix two moments.
  async poll() {
    try {
      const pairs = await Promise.all(Object.entries(QUERIES).map(async ([k, q]) => [k, await this.#query(q)]));
      this.#last = { ...Object.fromEntries(pairs), at: this.now() };
      return true;
    } catch {
      return false;
    }
  }

  read() { return this.#last && this.now() - this.#last.at <= STALE_MS ? { ...this.#last } : null; }
}
