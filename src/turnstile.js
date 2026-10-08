const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Server-side Turnstile check. Fails closed: any doubt means "not a human".
export async function verifyTurnstile({ secret, token, ip, fetchImpl = fetch }) {
  if (!token) return false;
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip ?? '' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}
