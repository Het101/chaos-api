// Tells the Change Timeline (Het101/change-timeline) what chaos-api did: experiments starting and
// finishing, and the error budget freezing or reopening. Best effort and fire-and-forget: the call is
// never awaited, has a 1 s timeout, and a timeline outage can never block or fail an experiment.

// Only these experiment fields leave chaos-api. Never ipHash: the timeline knows "a visitor", nothing more.
const FIELDS = ['id', 'action', 'title', 'startedAt', 'endedAt', 'status', 'recoveryMs', 'cost'];
export const pickExperiment = (exp) => Object.fromEntries(FIELDS.filter((k) => exp[k] !== undefined).map((k) => [k, exp[k]]));

export function createTimeline({ url, token, fetchImpl = fetch, timeoutMs = 1000, onError = () => {} } = {}) {
  if (!url || !token) return () => {}; // not configured: a no-op, so the lab runs without a timeline
  return (body) => {
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).then((res) => {
      res.body?.cancel?.();
      if (!res.ok) onError(new Error(`timeline answered ${res.status}`));
    }, onError);
  };
}
