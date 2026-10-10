// Parses environment variables once; everything else receives the result.
export function loadConfig(env = process.env) {
  const missing = ['INTERNAL_TOKEN', 'TURNSTILE_SECRET', 'BYPASS_TOKEN', 'IP_SALT'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  return {
    port: Number(env.PORT ?? 8080),
    appNamespace: env.APP_NAMESPACE ?? 'clinic',
    dataNamespace: env.DATA_NAMESPACE ?? 'clinic-data',
    selfNamespace: env.SELF_NAMESPACE ?? 'chaos',
    argoApp: env.ARGO_APP ?? 'clinic',
    argoNamespace: env.ARGO_NAMESPACE ?? 'argocd',
    internalToken: env.INTERNAL_TOKEN,
    turnstileSecret: env.TURNSTILE_SECRET,
    bypassToken: env.BYPASS_TOKEN,
    ipSalt: env.IP_SALT,
    probeUrl: env.PROBE_URL ?? 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/api/whoami',
    webUrl: env.WEB_URL ?? 'http://ingress-nginx-controller.ingress-nginx.svc.cluster.local/',
    probeHost: env.PROBE_HOST ?? 'lab.hetops.dev',
    loadUrl: env.LOAD_URL ?? 'http://api.clinic.svc.cluster.local/api/work',
    promUrl: env.PROM_URL ?? 'http://kps-kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090',
    allowedOrigin: env.ALLOWED_ORIGIN ?? 'https://hetops.dev',
    nodeMemoryBytes: Number(env.NODE_MEMORY_BYTES ?? 24 * 1024 ** 3),
    memoryThreshold: Number(env.MEMORY_THRESHOLD ?? 0.8),
    cooldownMs: 60_000,
    heavyPerHour: 3,
    experimentTimeoutMs: 600_000,
  };
}
