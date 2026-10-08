import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile } from '../src/turnstile.js';

test('no token: false, without calling Cloudflare', async () => {
  let called = false;
  assert.equal(await verifyTurnstile({ secret: 's', token: '', fetchImpl: async () => { called = true; } }), false);
  assert.equal(called, false);
});

test('posts secret, response and remoteip; true only on success', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: opts.body.toString() }; return { ok: true, json: async () => ({ success: true }) }; };
  assert.equal(await verifyTurnstile({ secret: 's3', token: 'tok', ip: '1.2.3.4', fetchImpl }), true);
  assert.equal(sent.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(sent.body, 'secret=s3&response=tok&remoteip=1.2.3.4');
});

test('failure, bad status and network errors are all false', async () => {
  assert.equal(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ success: false }) }) }), false);
  assert.equal(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await verifyTurnstile({ secret: 's', token: 't', fetchImpl: async () => { throw new Error('down'); } }), false);
});
