import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ACTIONS } from './actions.js';

const STATUS = { 'unknown-action': 404, busy: 409, healing: 409, cooldown: 429, 'hourly-cap': 429, disabled: 503, 'node-memory': 503 };
const same = (a, b) => {
  if (typeof a !== 'string' || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b); // byte lengths: timingSafeEqual throws on a mismatch
  return x.length === y.length && timingSafeEqual(x, y);
};

export function buildApp({ cfg, runner, stream, incidents, verifyTurnstile, latestSnapshot = () => null, logger = true }) {
  const app = Fastify({ logger });

  app.setErrorHandler((err, req, reply) => {
    if ((err.statusCode ?? 500) >= 500) {
      req.log.error({ err: err.message }, 'request failed');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.send(err);
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin === cfg.allowedOrigin) {
      reply.header('access-control-allow-origin', cfg.allowedOrigin);
      reply.header('vary', 'origin');
    }
  });

  app.options('/chaos/*', async (req, reply) => {
    reply.header('access-control-allow-methods', 'GET, POST');
    reply.header('access-control-allow-headers', 'content-type');
    return reply.code(204).send();
  });

  app.get('/chaos/health', async () => ({ ok: true }));
  app.get('/chaos/actions', async () => ACTIONS.map(({ id, title, heavy }) => ({ id, title, heavy })));
  app.get('/chaos/incidents', async () => incidents.list());

  app.get('/chaos/stream', (req, reply) => {
    if (stream.full) return reply.code(503).send({ reason: 'busy-stream' });
    reply.hijack(); // we own the raw response from here: it stays open
    const headers = req.headers.origin === cfg.allowedOrigin ? { 'access-control-allow-origin': cfg.allowedOrigin } : {};
    stream.add(reply.raw, headers);
    const snap = latestSnapshot();
    if (snap) stream.send(reply.raw, 'snapshot', snap);
  });

  app.post('/chaos/actions/:id', {
    schema: { body: { type: 'object', properties: { turnstileToken: { type: 'string', maxLength: 4096 } } } },
  }, async (req, reply) => {
    const ip = req.headers['cf-connecting-ip'] ?? req.ip;
    const bypass = same(req.headers['x-chaos-bypass'], cfg.bypassToken);
    if (!bypass && !(await verifyTurnstile({ secret: cfg.turnstileSecret, token: req.body?.turnstileToken, ip }))) {
      return reply.code(403).send({ reason: 'turnstile' });
    }
    const ipHash = createHash('sha256').update(cfg.ipSalt + ip).digest('hex').slice(0, 16);
    const result = await runner.start({ actionId: req.params.id, ipHash, bypass });
    if (!result.ok) return reply.code(STATUS[result.reason] ?? 400).send(result);
    return reply.code(202).send(result.experiment);
  });

  return app;
}
