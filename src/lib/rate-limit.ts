/** Fixed-window in-memory rate limiter. The app runs as a single process. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { ok: entry.count <= this.limit, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    this.lastSweep = now;
  }
}

export interface RateLimits {
  signIn: RateLimiter;
  signUp: RateLimiter;
  emailLink: RateLimiter;
  request: RateLimiter;
  comment: RateLimiter;
  vote: RateLimiter;
  report: RateLimiter;
  moderation: RateLimiter;
}

export function createRateLimits(): RateLimits {
  const minute = 60_000;
  return {
    signIn: new RateLimiter(10, 5 * minute),
    signUp: new RateLimiter(5, 60 * minute),
    emailLink: new RateLimiter(5, 15 * minute),
    request: new RateLimiter(5, 10 * minute),
    comment: new RateLimiter(20, 10 * minute),
    vote: new RateLimiter(120, minute),
    report: new RateLimiter(10, 10 * minute),
    moderation: new RateLimiter(120, minute),
  };
}
