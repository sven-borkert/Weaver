import { expect, it } from "vitest";
import { createApiKey, API_KEY_NAME_MAX_LENGTH } from "./apiKeys";
import { createSessionSecurityContext } from "../security/context";
it("reports the actual API key name length limit", async () => {
  const actor = createSessionSecurityContext({
    userId: "user",
    sessionId: "session",
    globalRole: "User",
  });
  await expect(
    createApiKey(
      {} as never,
      actor,
      {
        name: "x".repeat(API_KEY_NAME_MAX_LENGTH + 1),
        capabilities: [],
        projectIds: [],
        expiresInDays: null,
        rateLimitPerMinute: null,
      },
      {} as never,
    ),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: `Name must be at most ${API_KEY_NAME_MAX_LENGTH} characters`,
  });
});
