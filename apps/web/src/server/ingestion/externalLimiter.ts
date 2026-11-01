import {
  createSlidingWindowLimiter,
  type RateLimiter,
} from "@weaver/core/security/rateLimit";

import { env } from "~/env";

const MINUTE_MS = 60_000;
let configured: RateLimiter | undefined;
let override: RateLimiter | null = null;

/** Returns the per-credential external ingestion rate limiter. */
export function externalIngestionLimiter(): RateLimiter {
  if (override) return override;
  return (configured ??= createSlidingWindowLimiter({
    limit: env.WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE,
    windowMs: MINUTE_MS,
  }));
}

/** Replaces the limiter in tests; null restores the configured limiter. */
export function setExternalIngestionLimiterForTests(
  limiter: RateLimiter | null,
): void {
  override = limiter;
}
