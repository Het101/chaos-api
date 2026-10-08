const MAX_CLIENTS = 200;
const MAX_BUFFER = 256 * 1024;

// Server-Sent Events: one long HTTP response per viewer, named events pushed as they happen.
export class Stream {
  #clients = new Set();

  get full() { return this.#clients.size >= MAX_CLIENTS; }

  add(res, headers = {}) {
    if (this.full) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    res.write(': connected\n\n');
    this.#clients.add(res);
    res.on('close', () => this.#clients.delete(res));
    return true;
  }

  // A viewer that stopped reading must not grow our memory: cut it off.
  #write(res, chunk) {
    if (res.writableLength > MAX_BUFFER) { this.#clients.delete(res); res.destroy(); return; }
    res.write(chunk);
  }

  send(res, event, data) { this.#write(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  broadcast(event, data) { for (const res of [...this.#clients]) this.send(res, event, data); }

  heartbeat() { for (const res of [...this.#clients]) this.#write(res, ': ping\n\n'); } // keeps proxies from closing idle streams

  closeAll() { for (const res of this.#clients) res.end(); this.#clients.clear(); }

  get size() { return this.#clients.size; }
}
