// Fixed-window, in-memory rate limiter keyed by client IP. Each call session
// mints Webex tokens, so this stops one visitor (or a bot) from flooding the
// queue. For multi-instance deployments use a shared store or the limiter
// built into your API gateway / WAF instead.
export class RateLimiter {
  constructor({ max, windowMs, now = () => Date.now() }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  // Returns { allowed, retryAfterSeconds }.
  take(key) {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || t >= entry.resetAt) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    if (this.hits.size > 10_000) this.prune(t);
    if (entry.count >= this.max) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - t) / 1000) };
    }
    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  prune(t) {
    for (const [k, v] of this.hits) if (t >= v.resetAt) this.hits.delete(k);
  }
}
