// Fixed-window per-key rate limiter for a single-process Node server.
//
// Purpose: mitigate DDoS / brute-force amplification on the self-hosted
// dashboard (notably the /api/login endpoint, where every attempt runs an
// expensive synchronous scrypt). State lives in an in-process Map and the
// clock is injectable, so the rules are unit-testable without real time.
//
// NOT distributed — if you ever run >1 instance behind a balancer, replace
// this with a shared store (Redis etc.). One process is the deployment model
// here, so an in-memory counter is correct and dependency-free.

/**
 * Build a limiter.
 * @param {{windowMs:number, max:number, now?:() => number}} opts
 *   - windowMs: length of the counting window in ms.
 *   - max:     max requests permitted per key within one window.
 *   - now:     injectable clock (ms). Defaults to Date.now.
 * @returns {{
 *   check:(key:string)=>{allowed:boolean, retryAfterMs:number, count:number},
 *   reset:(key:string)=>void
 * }}
 */
export function createLimiter({ windowMs, max, now = Date.now } = {}) {
  if (!(windowMs > 0) || !(max > 0)) {
    throw new Error('createLimiter: windowMs and max must be > 0');
  }
  const hits = new Map(); // key -> { count, windowStart }

  /** Count one hit for `key`. Always increments; caller decides via `allowed`. */
  function check(key) {
    const t = now();
    let rec = hits.get(key);
    if (!rec || t - rec.windowStart >= windowMs) {
      rec = { count: 0, windowStart: t };
      hits.set(key, rec);
    }
    rec.count += 1;
    const allowed = rec.count <= max;
    const retryAfterMs = allowed ? 0 : Math.max(0, rec.windowStart + windowMs - t);
    // Bound memory: once the table grows large, drop expired entries. An
    // attacker rotating X-Forwarded-For can otherwise inflate this map; the
    // cleanup keeps it O(active IPs) rather than O(ips ever seen).
    if (hits.size > 50000) {
      for (const [k, r] of hits) if (t - r.windowStart >= windowMs) hits.delete(k);
    }
    return { allowed, retryAfterMs, count: rec.count };
  }

  /** Clear the counter for `key` (e.g. on a successful login). */
  function reset(key) {
    hits.delete(key);
  }

  return { check, reset };
}
