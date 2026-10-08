// Server-Sent Events: one long HTTP response per viewer, named events pushed as they happen.
export class Stream {
  #clients = new Set();

  add(res, headers = {}) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    res.write(': connected\n\n');
    this.#clients.add(res);
    res.on('close', () => this.#clients.delete(res));
  }

  send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  broadcast(event, data) { for (const res of this.#clients) this.send(res, event, data); }

  heartbeat() { for (const res of this.#clients) res.write(': ping\n\n'); } // keeps proxies from closing idle streams

  get size() { return this.#clients.size; }
}
