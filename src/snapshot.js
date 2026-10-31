import { summarizePod } from './pods.js';
import { brief } from './errors.js';

async function namespaceView(k8s, ns) {
  try {
    const [pods, deps] = await Promise.all([k8s.listPods(ns), k8s.listDeployments(ns)]);
    return {
      exists: true,
      pods: pods.map(summarizePod).sort((a, b) => a.name.localeCompare(b.name)),
      deployments: deps.map((d) => ({ name: d.metadata.name, desired: d.spec?.replicas ?? 0, available: d.status?.availableReplicas ?? 0 })),
    };
  } catch (err) {
    return { exists: false, error: brief(err), pods: [], deployments: [] }; // namespace nuked: draw an empty zone
  }
}

// ponytail: polling, not watches; it survives namespace deletion with no reconnect logic. Informers if the lab grows.
export async function takeSnapshot(k8s, cfg) {
  const [app, data, argo] = await Promise.all([
    namespaceView(k8s, cfg.appNamespace),
    namespaceView(k8s, cfg.dataNamespace),
    k8s.getArgoApp(cfg.argoNamespace, cfg.argoApp).then(
      (a) => ({ sync: a.status?.sync?.status ?? 'Unknown', health: a.status?.health?.status ?? 'Unknown', operation: a.status?.operationState?.phase ?? null }),
      (err) => ({ sync: 'Unknown', health: 'Unknown', operation: null, error: brief(err) }),
    ),
  ]);
  return { [cfg.appNamespace]: app, [cfg.dataNamespace]: data, argo };
}

// Every 1 s while someone watches (a console on the stream, an experiment running), else every idleMs.
// Polling every second with nobody watching was ~2 pod and ~2 deployment LISTs/s on the API server, all day.
export function pollSnapshots(refresh, watched, idleMs = 15_000) {
  let last = -Infinity;
  return setInterval(() => {
    if (!watched() && Date.now() - last < idleMs) return;
    last = Date.now();
    refresh();
  }, 1000);
}
