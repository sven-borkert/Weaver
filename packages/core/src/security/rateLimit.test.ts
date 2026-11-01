import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "./rateLimit";

describe("sliding window limiter (spec §26.2 item 9)", () => {
  it("allows up to the limit inside the window and reports Retry-After", () => {
    const limiter = createSlidingWindowLimiter({ limit: 3, windowMs: 1_000 });
    expect(limiter.check("a", 1_000)).toEqual({ allowed: true });
    expect(limiter.check("a", 1_100)).toEqual({ allowed: true });
    expect(limiter.check("a", 1_200)).toEqual({ allowed: true });
    expect(limiter.check("a", 1_300)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.check("a", 2_001)).toEqual({ allowed: true });
  });

  it("keeps keys independent and bounds the number of tracked keys", () => {
    const limiter = createSlidingWindowLimiter({
      limit: 1,
      windowMs: 1_000,
      maxKeys: 2,
    });
    expect(limiter.check("a", 0)).toEqual({ allowed: true });
    expect(limiter.check("b", 1)).toEqual({ allowed: true });
    expect(limiter.check("c", 2)).toMatchObject({ allowed: false });
    // New keys cannot evict an exhausted live bucket.
    expect(limiter.check("a", 3)).toMatchObject({ allowed: false });
    expect(limiter.check("c", 4)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.check("c", 1002)).toEqual({ allowed: true });
  });
});
