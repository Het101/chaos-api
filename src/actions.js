import { isReady } from './pods.js';

const pick = (list, random) => list[Math.floor(random() * list.length)];

async function readyApiPods(ctx) {
  const pods = (await ctx.k8s.listPods(ctx.cfg.appNamespace, 'app=api')).filter(isReady);
  if (!pods.length) throw new Error('no ready api pods');
  return pods;
}

async function internal(ctx, what) {
  const pod = pick(await readyApiPods(ctx), ctx.random);
  await ctx.http(`http://${pod.status.podIP}:8080/internal/${what}`, { method: 'POST', headers: { 'x-chaos-token': ctx.cfg.internalToken } });
  return { pod: pod.metadata.name };
}

// The fixed menu. Visitors pick an id; nothing else is ever executed.
export const ACTIONS = [
  { id: 'kill-pod', title: 'Kill a pod', heavy: false, run: async (ctx) => {
    const pod = pick(await readyApiPods(ctx), ctx.random);
    await ctx.k8s.deletePod(ctx.cfg.appNamespace, pod.metadata.name);
    return { pod: pod.metadata.name };
  } },
  { id: 'evict-api', title: 'Evict every API pod', heavy: false, run: async (ctx) => {
    const pods = await ctx.k8s.listPods(ctx.cfg.appNamespace, 'app=api');
    let evicted = 0, refused = 0;
    for (const p of pods) {
      try { await ctx.k8s.evictPod(ctx.cfg.appNamespace, p.metadata.name); evicted++; } catch { refused++; } // 429 = the PDB said no
    }
    return { evicted, refused };
  } },
  { id: 'delete-api-pods', title: 'Delete every API pod', heavy: false, run: async (ctx) => {
    const pods = await ctx.k8s.listPods(ctx.cfg.appNamespace, 'app=api');
    for (const p of pods) await ctx.k8s.deletePod(ctx.cfg.appNamespace, p.metadata.name);
    return { deleted: pods.length };
  } },
  { id: 'crash', title: 'Crash the process', heavy: false, run: (ctx) => internal(ctx, 'crash') },
  { id: 'leak', title: 'Memory leak', heavy: false, run: (ctx) => internal(ctx, 'leak') },
  { id: 'hang', title: 'Hang the app', heavy: false, run: (ctx) => internal(ctx, 'hang') },
  { id: 'scale-zero', title: 'Scale the API to 0', heavy: false, run: async (ctx) => {
    await ctx.k8s.scaleDeployment(ctx.cfg.appNamespace, 'api', 0);
    return {};
  } },
  { id: 'delete-web', title: 'Delete the web Deployment', heavy: false, run: async (ctx) => {
    await ctx.k8s.deleteDeployment(ctx.cfg.appNamespace, 'web');
    return {};
  } },
  { id: 'delete-api-svc', title: 'Delete the api Service', heavy: false, run: async (ctx) => {
    await ctx.k8s.deleteService(ctx.cfg.appNamespace, 'api');
    return {};
  } },
  { id: 'bad-release', title: 'Ship a bad release by hand', heavy: false, run: async (ctx) => {
    const api = (await ctx.k8s.listDeployments(ctx.cfg.appNamespace)).find((d) => d.metadata.name === 'api');
    const image = api.spec.template.spec.containers[0].image.replace(/:[^:/]+$/, ':bad');
    await ctx.k8s.setImage(ctx.cfg.appNamespace, 'api', 'api', image);
    return { image };
  } },
  { id: 'delete-secret', title: 'Delete the database Secret', heavy: false, run: async (ctx) => {
    await ctx.k8s.deleteSecret(ctx.cfg.appNamespace, 'clinic-db');
    return {};
  } },
  { id: 'rogue-netpol', title: 'Inject a rogue deny-all NetworkPolicy', heavy: false, run: async (ctx) => {
    const ns = ctx.cfg.appNamespace;
    await ctx.k8s.createNetworkPolicy(ns, {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'chaos-deny-all',
        // Argo CD's tracking annotation: Argo CD now thinks it owns this, sees it is not in git, and prunes it.
        annotations: { 'argocd.argoproj.io/tracking-id': `${ctx.cfg.argoApp}:networking.k8s.io/NetworkPolicy:${ns}/chaos-deny-all` },
      },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
    });
    return {};
  } },
  { id: 'kill-postgres', title: 'Kill Postgres', heavy: false, run: async (ctx) => {
    await ctx.k8s.deletePod(ctx.cfg.dataNamespace, 'postgres-0');
    return {};
  } },
  { id: 'traffic-spike', title: 'Traffic spike', heavy: true, run: async (ctx) => {
    ctx.load(90_000); // runs in the background; the HPA reacts within a minute
    return { seconds: 90 };
  } },
  { id: 'nuke-namespace', title: 'Nuke the clinic namespace', heavy: true, run: async (ctx) => {
    await ctx.k8s.deleteNamespace(ctx.cfg.appNamespace);
    return {};
  } },
];

export const findAction = (id) => ACTIONS.find((a) => a.id === id);

// Background traffic for traffic-spike: N loops hammering a CPU-heavy endpoint until the deadline.
export function makeLoad({ url, fetchImpl = fetch, concurrency = 8 }) {
  return (ms) => {
    const until = Date.now() + ms;
    for (let i = 0; i < concurrency; i++) {
      (async () => {
        while (Date.now() < until) {
          try { await fetchImpl(url, { signal: AbortSignal.timeout(5000) }); } catch { /* failures are part of the show */ }
        }
      })();
    }
  };
}
