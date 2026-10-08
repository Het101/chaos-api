export const isReady = (pod) =>
  !pod.metadata?.deletionTimestamp &&
  (pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

// The one-line view of a pod the console page draws.
export function summarizePod(pod) {
  const cs = pod.status?.containerStatuses?.[0];
  let state = pod.status?.phase ?? 'Unknown';
  if (pod.metadata?.deletionTimestamp) state = 'Terminating';
  else if (cs?.state?.waiting?.reason) state = cs.state.waiting.reason;
  else if (cs?.state?.terminated?.reason) state = cs.state.terminated.reason;
  return {
    name: pod.metadata.name,
    app: pod.metadata.labels?.app ?? '',
    state,
    ready: isReady(pod),
    restarts: cs?.restartCount ?? 0,
    lastReason: cs?.lastState?.terminated?.reason ?? null,
  };
}
