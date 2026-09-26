/**
 * In-process token buckets, keyed by client address and bucket name. The demo
 * is public and runs as one instance on a free plan, so a per-process limiter
 * is the honest amount of protection: it stops one client from filling the
 * database or the extraction queue, and says so with 429 and Retry-After.
 * A multi-instance deployment needs a shared limiter in front (ADR-0017).
 */

export interface BucketRule {
  /** Tokens added per minute; also the burst size. 0 disables the bucket. */
  readonly perMinute: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds until one token is available again (0 when allowed). */
  readonly retryAfterSeconds: number;
  readonly remaining: number;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rules: Readonly<Record<string, BucketRule>>,
    private readonly now: () => number = Date.now,
    /** Oldest keys are evicted past this size, so a scan of addresses cannot exhaust memory. */
    private readonly maxKeys = 10_000,
  ) {
    for (const [name, rule] of Object.entries(rules)) {
      if (!Number.isInteger(rule.perMinute) || rule.perMinute < 0) throw new Error(`rate limit ${name}: perMinute must be a non-negative integer`);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  take(bucket: string, client: string): RateDecision {
    const rule = this.rules[bucket];
    if (!rule) throw new Error(`unknown rate limit bucket: ${bucket}`);
    if (rule.perMinute === 0) return { allowed: true, retryAfterSeconds: 0, remaining: Infinity };
    const key = `${bucket}\u0000${client}`;
    const nowMs = this.now();
    const ratePerMs = rule.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(rule.perMinute, b.tokens + (nowMs - b.updatedMs) * ratePerMs);
      b.updatedMs = nowMs;
      // Re-insert so Map order tracks recency for eviction.
      this.buckets.delete(key);
    } else {
      b = { tokens: rule.perMinute, updatedMs: nowMs };
    }
    this.buckets.set(key, b);
    this.evict();
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(b.tokens) };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)), remaining: 0 };
  }

  private evict(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}

/** Which bucket a request draws from, or undefined when it is not limited. Reads are never limited. */
export function bucketFor(method: string, url: string): 'uploads' | 'writes' | undefined {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/v1/')) return undefined;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return undefined;
  if (m === 'POST' && path === '/v1/invoices') return 'uploads';
  return 'writes';
}
