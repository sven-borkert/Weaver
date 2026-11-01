import { beforeEach, expect, it } from "vitest";
import { checkUploadRateLimit } from "@weaver/core/ingestion/rateLimit";
import { getPrisma, makeUser, resetDb } from "./_harness";

beforeEach(resetDb);
it("shares upload limits across concurrent requests and resets old windows", async () => {
  const user = await makeUser("User", "upload-limit");
  const db = getPrisma();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      checkUploadRateLimit(db, user.id, "browser", 3),
    ),
  );
  expect(results.filter((result) => result.allowed)).toHaveLength(3);
  expect((await checkUploadRateLimit(db, user.id, "external", 3)).allowed).toBe(
    true,
  );
  await db.uploadRateLimit.updateMany({
    where: { userId: user.id },
    data: { windowStart: new Date(0) },
  });
  expect((await checkUploadRateLimit(db, user.id, "browser", 3)).allowed).toBe(
    true,
  );
});

it("does not move an upload window backward for a delayed request", async () => {
  const user = await makeUser("User", "upload-delayed");
  const db = getPrisma();
  const windowStart = new Date(Date.now() + 120_000);
  await db.uploadRateLimit.create({
    data: { userId: user.id, channel: "browser", windowStart, count: 1 },
  });
  await checkUploadRateLimit(db, user.id, "browser", 3);
  const row = await db.uploadRateLimit.findUniqueOrThrow({
    where: { userId_channel: { userId: user.id, channel: "browser" } },
  });
  expect(row.windowStart).toEqual(windowStart);
  expect(row.count).toBe(2);
});
