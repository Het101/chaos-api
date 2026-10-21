// Tells the Change Timeline (Het101/change-timeline) what chaos-api did: experiments starting and
// finishing, and the error budget freezing or reopening. Best effort and fire-and-forget: the call is
// never awaited, each try has a 1 s timeout, and a timeline outage can never block or fail an experiment.

// Only these experiment fields leave chaos-api. Never ipHash: the timeline knows "a visitor", nothing more.
const FIELDS = ['id', 'action', 'title', 'startedAt', 'endedAt', 'status', 'recoveryMs', 'cost'];
export const pickExperiment = (exp) => Object.fromEntries(FIELDS.filter((k) => exp[k] !== undefined).map((k) => [k, exp[k]]));

// Retries: a timeline restart takes 10 to 50 s, and on game day (21 Oct) one dropped an experiment's
// finish. A network error, a timeout or a 5xx is tried again after 2, 5, 15 and 30 s; a 4xx is a wrong
// request and is not. The timeline dedupes every event, so a retry of one that did land adds nothing.
const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

export function createTimeline({ url, token, fetchImpl = fetch, timeoutMs = 1000, onError = () => {},
  retryMs = [2000, 5000, 15000, 30000], sleep = wait } = {}) {
  if (!url || !token) return () => {}; // not configured: a no-op, so the lab runs without a timeline
  const post = async (body) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retryMs.length;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (last) throw err;
        await sleep(retryMs[attempt]);
        continue;
      }
      res.body?.cancel?.();
      if (res.ok) return;
      if (res.status < 500 || last) throw new Error(`timeline answered ${res.status}`);
      await sleep(retryMs[attempt]);
    }
  };
  return (body) => { post(body).catch(onError); };
}
