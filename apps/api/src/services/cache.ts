import { redis } from "../lib/redis.js";

const DEFAULT_TTL = 60;
const FALLBACK_TTL = 24 * 60 * 60;

/**
 * Cache is an accelerator, never a source of truth. A Redis outage must never
 * fail a DB read or write, so every operation here is fail-soft: on error we
 * log and return a safe default. The system runs in "degraded" mode (see
 * /health) with cold reads hitting Postgres directly and version bumps skipped.
 */
async function safe<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await op();
  } catch (err) {
    console.warn(`[cache] ${label} failed, degrading:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Write a snapshot to the emergency fallback keyspace. 24h TTL, separate from live cache. */
export async function writeFallback(tenantId: string, payload: unknown) {
  await safe(
    () => redis.set(`kb_fallback:${tenantId}`, JSON.stringify(payload), "EX", FALLBACK_TTL),
    null,
    "writeFallback",
  );
}

export async function readFallback<T>(tenantId: string): Promise<T | null> {
  const raw = await safe(() => redis.get(`kb_fallback:${tenantId}`), null, "readFallback");
  return raw ? (JSON.parse(raw) as T) : null;
}

/** Tenant-scoped version counter. Incremented on every write. */
export async function bumpVersion(tenantId: string, module?: string): Promise<number> {
  const key = module ? `ver:${tenantId}:${module}` : `ver:${tenantId}`;
  return safe(() => redis.incr(key), 0, "bumpVersion");
}

export async function currentVersion(tenantId: string, module?: string): Promise<number> {
  const key = module ? `ver:${tenantId}:${module}` : `ver:${tenantId}`;
  const v = await safe(() => redis.get(key), null, "currentVersion");
  return v ? parseInt(v, 10) : 0;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await safe(() => redis.get(key), null, "cacheGet");
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function cacheSet<T>(key: string, value: T, ttl = DEFAULT_TTL): Promise<void> {
  await safe(() => redis.set(key, JSON.stringify(value), "EX", ttl), null, "cacheSet");
}

/** Single-flight: first caller computes, others wait for result. Degrades to a plain compute() if Redis is down. */
export async function withSingleFlight<T>(
  key: string,
  compute: () => Promise<T>,
  ttl = DEFAULT_TTL,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached) return cached;

  const lockKey = `${key}:lock`;
  // Distinguish "lock held by another caller" (null) from "Redis is down" (throw):
  // when Redis is down there is no other caller to wait for, so compute immediately
  // instead of burning ~1s polling a cache that will never populate.
  let got: unknown = null;
  let redisDown = false;
  try {
    got = await redis.set(lockKey, "1", "EX", 5, "NX");
  } catch (err) {
    redisDown = true;
    console.warn(
      "[cache] singleFlight.lock failed, degrading:",
      err instanceof Error ? err.message : err,
    );
  }
  if (got) {
    try {
      const value = await compute();
      await cacheSet(key, value, ttl);
      return value;
    } finally {
      await safe(() => redis.del(lockKey), null, "singleFlight.unlock");
    }
  }
  if (redisDown) return compute();
  // Lost the race; poll briefly for the winner's result, then compute as a fallback.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const cached2 = await cacheGet<T>(key);
    if (cached2) return cached2;
  }
  return compute();
}
