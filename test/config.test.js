import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { INTERNAL_TOKEN: 'i', TURNSTILE_SECRET: 't', BYPASS_TOKEN: 'b', IP_SALT: 's' };

test('defaults match the lab', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.appNamespace, 'clinic');
  assert.equal(c.dataNamespace, 'clinic-data');
  assert.equal(c.selfNamespace, 'chaos');
  assert.equal(c.argoApp, 'clinic');
  assert.equal(c.argoNamespace, 'argocd');
  assert.equal(c.probeUrl, 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/api/whoami');
  assert.equal(c.webUrl, 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/');
  assert.equal(c.probeHost, 'lab.hetops.dev');
  assert.equal(c.loadUrl, 'http://api.clinic.svc.cluster.local/api/work');
  assert.equal(c.allowedOrigin, 'https://hetops.dev');
  assert.equal(c.nodeMemoryBytes, 24 * 1024 ** 3);
  assert.equal(c.memoryThreshold, 0.8);
  assert.equal(c.cooldownMs, 60_000);
  assert.equal(c.heavyPerHour, 3);
  assert.equal(c.experimentTimeoutMs, 600_000);
});

test('fails fast without its secrets', () => {
  assert.throws(() => loadConfig({ INTERNAL_TOKEN: 'i' }), /missing env: TURNSTILE_SECRET, BYPASS_TOKEN, IP_SALT/);
});
