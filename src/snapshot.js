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

// ponytail: 1 s polling, not watches; it survives namespace deletion with no reconnect logic. Informers if the lab grows.
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
