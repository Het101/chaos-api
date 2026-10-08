import * as k8s from '@kubernetes/client-node';
import { bytes } from './units.js';

export function createK8s() {
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster(); // the pod's ServiceAccount token
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const metrics = new k8s.Metrics(kc);
  const merge = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch);
  const strategic = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch);

  return {
    listPods: async (namespace, labelSelector) => (await core.listNamespacedPod({ namespace, labelSelector })).items,
    deletePod: (namespace, name) => core.deleteNamespacedPod({ namespace, name }),
    evictPod: (namespace, name) => core.createNamespacedPodEviction({
      namespace, name, body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } },
    }),
    listDeployments: async (namespace) => (await apps.listNamespacedDeployment({ namespace })).items,
    scaleDeployment: (namespace, name, replicas) => apps.patchNamespacedDeploymentScale({ namespace, name, body: { spec: { replicas } } }, merge),
    setImage: (namespace, name, container, image) => apps.patchNamespacedDeployment({
      namespace, name, body: { spec: { template: { spec: { containers: [{ name: container, image }] } } } },
    }, strategic),
    deleteDeployment: (namespace, name) => apps.deleteNamespacedDeployment({ namespace, name }),
    deleteService: (namespace, name) => core.deleteNamespacedService({ namespace, name }),
    deleteSecret: (namespace, name) => core.deleteNamespacedSecret({ namespace, name }),
    createNetworkPolicy: (namespace, body) => net.createNamespacedNetworkPolicy({ namespace, body }),
    deleteNamespace: (name) => core.deleteNamespace({ name }),
    getArgoApp: (namespace, name) => custom.getNamespacedCustomObject({ group: 'argoproj.io', version: 'v1alpha1', namespace, plural: 'applications', name }),
    nodeMemoryUsedBytes: async () => (await metrics.getNodeMetrics()).items.reduce((sum, n) => sum + bytes(n.usage.memory), 0),
    readConfigMap: (namespace, name) => core.readNamespacedConfigMap({ namespace, name }),
    patchConfigMap: (namespace, name, data) => core.patchNamespacedConfigMap({ namespace, name, body: { data } }, merge),
  };
}
