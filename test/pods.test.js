import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReady, summarizePod } from '../src/pods.js';

const pod = (over = {}) => ({
  metadata: { name: 'api-1', labels: { app: 'api' }, ...over.metadata },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ restartCount: 2, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled' } } }],
    ...over.status,
  },
});

test('ready only when the Ready condition is True and not terminating', () => {
  assert.equal(isReady(pod()), true);
  assert.equal(isReady(pod({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })), false);
  assert.equal(isReady(pod({ metadata: { deletionTimestamp: '2026-10-08T00:00:00Z' } })), false);
});

test('summary shows the most useful state', () => {
  assert.deepEqual(summarizePod(pod()), { name: 'api-1', app: 'api', state: 'Running', ready: true, restarts: 2, lastReason: 'OOMKilled' });
  const waiting = pod({ status: { containerStatuses: [{ restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } });
  assert.equal(summarizePod(waiting).state, 'CrashLoopBackOff');
  assert.equal(summarizePod(pod({ metadata: { deletionTimestamp: 'x' } })).state, 'Terminating');
});
