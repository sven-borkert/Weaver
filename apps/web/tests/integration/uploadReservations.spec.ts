import { beforeEach, describe, expect, it } from "vitest";
import { reserveUpload } from "@weaver/core/ingestion/uploadReservations";
import { getPrisma, makeProject, makeUser, resetDb } from "./_harness";

describe("upload reservations", () => {
  beforeEach(resetDb);

  it("caps concurrent requests per user across projects and frees released slots", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "reservation-slots");
    const project = await makeProject("Reserved uploads");
    const input = {
      userId: user.id,
      projectId: project.id,
      declaredBytes: 10,
      quotaBytes: 1000,
    };
    const reservations = [];
    try {
      for (let i = 0; i < 3; i++)
        reservations.push(await reserveUpload(db, input));
      await expect(reserveUpload(db, input)).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      await reservations.pop()!.release();
      reservations.push(await reserveUpload(db, input));
    } finally {
      for (const reservation of reservations) await reservation.release();
    }
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it("does not grant unverified replacement credit before staging", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "reservation-replace");
    const project = await makeProject("Replacement quota");
    await db.artifact.create({
      data: {
        projectId: project.id,
        filename: "large.bin",
        filenameKey: "large.bin",
        contentDigest: "a".repeat(64),
        byteSize: 100,
        contentType: "application/octet-stream",
        uploadedById: user.id,
      },
    });
    const input = {
      userId: user.id,
      projectId: project.id,
      declaredBytes: 60,
      quotaBytes: 100,
      replaceFilenameKeys: ["large.bin"],
    };
    await expect(reserveUpload(db, input)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it("accounts for concurrent staging, bounds unknown-length uploads, and releases quota", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "reservation-budget");
    const project = await makeProject("Reserved bytes");
    const input = {
      userId: user.id,
      projectId: project.id,
      declaredBytes: 60,
      quotaBytes: 100,
    };
    const first = await reserveUpload(db, input);
    try {
      await expect(reserveUpload(db, input)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      const second = await reserveUpload(db, { ...input, declaredBytes: 0 });
      try {
        await second.consume(40);
        await expect(second.consume(1)).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
        });
      } finally {
        await second.release();
      }
      await first.consume(60);
    } finally {
      await first.release();
    }
    const last = await reserveUpload(db, { ...input, declaredBytes: 100 });
    await last.release();
  });
});
