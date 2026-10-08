// The last N experiments, newest first. save() persists them (best effort).
export class IncidentLog {
  #items = [];

  constructor({ max = 50, save = async () => {} } = {}) {
    this.max = max;
    this.save = save;
  }

  load(items) { this.#items = Array.isArray(items) ? items.slice(0, this.max) : []; }

  add(exp) {
    this.#items.unshift({ ...exp });
    if (this.#items.length > this.max) this.#items.length = this.max;
    this.save(this.list()).catch(() => {});
  }

  list() { return [...this.#items]; }
}
