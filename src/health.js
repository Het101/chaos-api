import { isReady } from './pods.js';
import { brief } from './errors.js';

// "Is the lab fully healthy?", the gate before every experiment and the finish line after it.
export async function checkHealth(k8s, cfg) {
  const reasons = [];
  try {
    const deps = await k8s.listDeployments(cfg.appNamespace);
    for (const name of ['api', 'web', 'worker']) {
      const d = deps.find((x) => x.metadata.name === name);
      if (!d) { reasons.push(`${name}: missing`); continue; }
      const want = d.spec?.replicas ?? 1;
      const have = d.status?.availableReplicas ?? 0;
      if (want < 1 || have < want) reasons.push(`${name}: ${have}/${want} available`);
    }
  } catch (err) {
    reasons.push(`${cfg.appNamespace}: ${brief(err)}`);
  }
  try {
    const pods = await k8s.listPods(cfg.dataNamespace, 'app=postgres');
    if (!pods.some(isReady)) reasons.push('postgres: not ready');
  } catch (err) {
    reasons.push(`postgres: ${brief(err)}`);
  }
  try {
    const app = await k8s.getArgoApp(cfg.argoNamespace, cfg.argoApp);
    const sync = app.status?.sync?.status;
    const health = app.status?.health?.status;
    if (sync !== 'Synced' || health !== 'Healthy') reasons.push(`argo: ${sync}/${health}`);
  } catch (err) {
    reasons.push(`argo: ${brief(err)}`);
  }
  return { healthy: reasons.length === 0, reasons };
}

// Shared node with live sites: refuse experiments when memory is tight, and when we cannot tell.
export async function checkMemory(k8s, cfg) {
  try {
    return (await k8s.nodeMemoryUsedBytes()) / cfg.nodeMemoryBytes < cfg.memoryThreshold;
  } catch {
    return false;
  }
}
