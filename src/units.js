const UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1e3, M: 1e6, G: 1e9 };

// Kubernetes memory quantity ("5024Mi") -> bytes.
export function bytes(quantity) {
  const m = String(quantity).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/);
  if (!m) throw new Error(`bad quantity: ${quantity}`);
  return Number(m[1]) * (m[2] ? UNITS[m[2]] : 1);
}
