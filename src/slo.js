import { withTimeout } from './errors.js';
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
  lastError = null; // why the last poll failed (null after a good one), so the caller can log it

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
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      return false;
    }
  }

  read() { return this.#last && this.now() - this.#last.at <= STALE_MS ? { ...this.#last } : null; }
}

// The error budget policy: when the budget is spent, visitor chaos freezes until 5% is back. The gap between
// freezeAt and reopenAt stops the lab flapping around zero. Thresholds live in chaos-config (FREEZE_AT, REOPEN_AT)
// so the owner can test a freeze without spending real budget.
export const DEFAULTS = { freezeAt: 0, reopenAt: 0.05 };

export function parseThresholds(data = {}) {
  const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  return { freezeAt: num(data?.FREEZE_AT, DEFAULTS.freezeAt), reopenAt: num(data?.REOPEN_AT, DEFAULTS.reopenAt) };
}

export class BudgetPolicy {
  #frozen = false;
  #state = null;
  #ticking = false;

  constructor({ reader, readThresholds = async () => DEFAULTS, broadcast = () => {}, gauge = null, thresholdsMs = 5000 }) {
    Object.assign(this, { reader, readThresholds, broadcast, gauge, thresholdsMs });
  }

  get frozen() { return this.#frozen; }
  get state() { return this.#state; }

  async tick() {
    if (this.#ticking) return; // a slow tick must never be overtaken by the next one
    this.#ticking = true;
    try {
      const t = await withTimeout(this.readThresholds(), this.thresholdsMs, 'thresholds').catch(() => DEFAULTS);
      await this.reader.poll();
      const slo = this.reader.read();
      if (!slo) this.#frozen = false; // fail open: broken monitoring must not take the lab down (SLIMissing pages instead)
      else if (slo.budget <= t.freezeAt) this.#frozen = true;
      else if (slo.budget >= t.reopenAt) this.#frozen = false;
      this.#state = slo ? { budget: slo.budget, sli7d: slo.sli7d, burn5m: slo.burn5m, burn1h: slo.burn1h, frozen: this.#frozen } : null;
      this.gauge?.set(this.#frozen ? 1 : 0);
      this.broadcast('slo', this.#state);
    } finally {
      this.#ticking = false;
    }
  }
}
