export type RateLimitDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type RateLimiter = {
  check(key: string, now?: number): RateLimitDecision;
};

/** In-process sliding window; single-instance is the documented deployment (spec §26.2 item 9). */
export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  // Insertion order doubles as recency: a key is deleted and re-set on every hit.
  const hits = new Map<string, number[]>();
  return {
    check(key, now = Date.now()) {
      const floor = now - options.windowMs;
      let stamps = hits.get(key);
      if (stamps) {
        hits.delete(key);
        while (stamps.length > 0 && stamps[0]! <= floor) stamps.shift();
      } else {
        if (hits.size >= maxKeys) {
          const evictable = [...hits].find(
            ([, values]) => values.at(-1)! <= floor,
          );
          if (evictable) hits.delete(evictable[0]);
          else
            return {
              allowed: false,
              retryAfterSeconds: Math.max(
                1,
                Math.ceil(options.windowMs / 1_000),
              ),
            };
        }
        stamps = [];
      }
      if (stamps.length >= options.limit) {
        hits.set(key, stamps);
        const retryAfterMs = stamps[0]! + options.windowMs - now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
        };
      }
      stamps.push(now);
      hits.set(key, stamps);
      return { allowed: true };
    },
  };
}
