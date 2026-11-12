import { createHash } from "node:crypto";
import { createSlidingWindowLimiter } from "@weaver/core/security/rateLimit";
import { CoreError } from "@weaver/core/errors";
import { PROJECT_API_MAX_RATE_LIMIT } from "@weaver/core/projectApi/constants";
import { processSingleton } from "@weaver/core/diagnostics/processState";

const WINDOW_MS = 60_000;

export function createProjectApiAdmission() {
  const sources = createSlidingWindowLimiter({
    limit: 240,
    windowMs: WINDOW_MS,
  });
  const credentials = createSlidingWindowLimiter({
    limit: PROJECT_API_MAX_RATE_LIMIT * 2,
    windowMs: WINDOW_MS,
  });
  const known = new Map<string, number>();
  return {
    check(authorization: string | null, source: string, now = Date.now()) {
      const hash = createHash("sha256")
        .update(authorization ?? "")
        .digest("hex");
      const decision =
        (known.get(hash) ?? 0) > now
          ? credentials.check(hash, now)
          : sources.check(source, now);
      if (!decision.allowed)
        throw new CoreError("TOO_MANY_REQUESTS", "Rate limit exceeded", {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      return {
        verified() {
          known.delete(hash);
          if (known.size >= 10_000) known.delete(known.keys().next().value!);
          known.set(hash, now + WINDOW_MS);
        },
        rejected() {
          known.delete(hash);
        },
      };
    },
  };
}

export const projectApiAdmission = processSingleton(
  "project-api-admission",
  createProjectApiAdmission,
);
