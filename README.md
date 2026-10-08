# chaos-api

Lets visitors break the [HetOps Kubernetes lab](https://github.com/Het101/hetops-k8s-lab) from a fixed menu of 15 actions, and streams the cluster healing itself.

- **Guardrails:** one experiment at a time; refuses while the lab is unhealthy; Cloudflare Turnstile; 60 s cooldown per visitor; heavy actions max 3/hour; kill switch (`chaos-config` ConfigMap); refuses above 80% node memory.
- **Routes:** `GET /chaos/actions`, `POST /chaos/actions/:id`, `GET /chaos/stream` (Server-Sent Events: `snapshot`, `probes`, `experiment`), `GET /chaos/incidents`, `GET /chaos/health`.
- **Env:** `INTERNAL_TOKEN`, `TURNSTILE_SECRET`, `BYPASS_TOKEN`, `IP_SALT` (required); `ALLOWED_ORIGIN`, `NODE_MEMORY_BYTES`, `PROBE_URL`, `LOAD_URL`, namespaces (optional).
- Least-privilege RBAC lives in the lab repo (`apps/chaos/rbac.yaml`).

```bash
npm ci && npm test
```

Images: `ghcr.io/het101/chaos-api:<sha>` (ARM64), published from `main`.
