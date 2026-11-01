import { expect, it, vi } from "vitest";
import { listProjectsForAdmin } from "./users";
import { createSessionSecurityContext } from "../security/context";
it("bounds the administration project picker", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i),
    name: `Project ${i}`,
  }));
  const db = {
    project: {
      findMany: vi.fn(async ({ take }: { take?: number }) =>
        rows.slice(0, take ?? rows.length),
      ),
    },
  };
  const actor = createSessionSecurityContext({
    userId: "admin",
    sessionId: "session",
    globalRole: "Admin",
  });
  expect(await listProjectsForAdmin(db as never, actor)).toHaveLength(1000);
});
