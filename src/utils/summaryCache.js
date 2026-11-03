// Short-lived process-local cache for GLOBAL cards only. Replace getCachedSummary
// with Redis GET/SETEX when multiple Express instances are deployed.
const entries = new Map();
const TTL_MS = 45_000;
export function clearSummaryCache() { entries.clear(); }
export async function getCachedSummary(key, loader) {
  const now = Date.now();
  const existing = entries.get(key);
  if (existing && existing.expires > now) return existing.promise;
  if (entries.size >= 500) {
    for (const [old, value] of entries) if (value.expires <= now) entries.delete(old);
    if (entries.size >= 500) entries.delete(entries.keys().next().value);
  }
  const promise = Promise.resolve().then(loader);
  entries.set(key, { expires: now + TTL_MS, promise });
  try { return await promise; }
  catch (error) { entries.delete(key); throw error; }
}
