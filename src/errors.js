// Kubernetes error text (bodies, headers, RBAC detail) must never reach the public: expose only this.
export const brief = (err) => {
  const code = err?.code ?? err?.statusCode;
  return typeof code === 'number' ? `HTTP ${code}` : 'unreachable';
};

// One hung Kubernetes call must not hold the lock or freeze the stream.
export const withTimeout = (promise, ms, label = 'call') => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};
