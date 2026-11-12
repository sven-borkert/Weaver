import { CoreError } from "@weaver/core/errors";
import { processSingleton } from "@weaver/core/diagnostics/processState";
import { createSlidingWindowLimiter } from "@weaver/core/security/rateLimit";
import { env } from "~/env";

export const transferCredentialLimiter = processSingleton(
  "transfer-credential-limiter",
  () =>
    createSlidingWindowLimiter({
      limit: env.WEAVER_MCP_RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
    }),
);

export function createTransferSlots() {
  const active = new Map<string, number>();
  let total = 0;
  return (userId: string) => {
    const count = active.get(userId) ?? 0;
    if (count >= 2 || total >= 8)
      throw new CoreError(
        "TOO_MANY_REQUESTS",
        "Too many concurrent transfers",
        { retryAfterSeconds: 1 },
      );
    active.set(userId, count + 1);
    total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      total--;
      const remaining = (active.get(userId) ?? 1) - 1;
      if (remaining) active.set(userId, remaining);
      else active.delete(userId);
    };
  };
}

export const acquireTransferSlot = processSingleton(
  "transfer-body-slots",
  createTransferSlots,
);
