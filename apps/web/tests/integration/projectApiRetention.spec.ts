import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db as appDb } from "@weaver/db";
import { pruneProjectApiRecords } from "@weaver/core/projectApi/retention";
import { recordProjectApiAudit } from "@weaver/core/projectApi/audit";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
import { POST as appendRows } from "../../src/app/api/v1/projects/[projectId]/tables/[tableId]/rows/route";
import { PUT as replaceDocument } from "../../src/app/api/v1/projects/[projectId]/documents/[documentId]/route";
import {
  makeMachineFixture,
  seedProjectMachineKey,
  type MachineFixture,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";

const DAY = 86_400_000;
const NOW = new Date("2026-10-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function operationRows(
  f: MachineFixture,
  keyId: string,
  rows: { key: string; state: "reserved" | "succeeded" | "failed"; at: Date }[],
) {
  await f.db.projectApiOperation.createMany({
    data: rows.map(({ key, state, at }) => ({
      keyId,
      projectId: f.project.id,
      idempotencyKey: key,
      operation: "document.create",
      requestHash: "a".repeat(64),
      state,
      generatedIds: {},
      authorizingAnchors: {},
      createdAt: at,
      ...(state === "succeeded"
        ? { commitSha: "b".repeat(40), receipt: {}, httpStatus: 201 }
        : {}),
      ...(state === "failed"
        ? { error: { code: "BAD_REQUEST" }, httpStatus: 400 }
        : {}),
      ...(state === "reserved" ? {} : { completedAt: at }),
    })),
  });
}

const auditEvent = (f: MachineFixture, keyId: string) => ({
  requestId: randomUUID(),
  projectId: f.project.id,
  keyId,
  method: "POST" as const,
  operation: "document.create",
  resourceId: null,
  outcome: "succeeded" as const,
  status: 201,
  durationMs: 10,
  commitSha: "b".repeat(40),
});

describe("project API record retention", () => {
  beforeEach(resetDb);
  afterAll(closeProjectApiOperationPool);

  it("prunes at exact UTC boundaries and never removes uncertain reservations", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, []);
    await operationRows(f, k.keyId, [
      {
        key: "receipt-just-expired",
        state: "succeeded",
        at: ago(30 * DAY + 1),
      },
      { key: "receipt-at-boundary", state: "failed", at: ago(30 * DAY) },
      { key: "failure-expired-01", state: "failed", at: ago(45 * DAY) },
      { key: "reservation-ancient", state: "reserved", at: ago(400 * DAY) },
    ]);
    for (const at of [ago(90 * DAY + 1), ago(90 * DAY), ago(DAY)]) {
      await recordProjectApiAudit(f.db, auditEvent(f, k.keyId));
      const latest = await f.db.projectApiAuditEvent.findFirstOrThrow({
        orderBy: { createdAt: "desc" },
      });
      await f.db.projectApiAuditEvent.update({
        where: { id: latest.id },
        data: { createdAt: at },
      });
    }
    await f.db.projectApiRateWindow.create({
      data: {
        keyId: k.keyId,
        windowStartedAt: ago(10 * 60_000),
        requestCount: 3,
      },
    });

    expect(await pruneProjectApiRecords(f.db, NOW)).toEqual({
      operations: 2,
      audits: 1,
      rateWindows: 1,
    });
    expect(
      (
        await f.db.projectApiOperation.findMany({
          orderBy: { idempotencyKey: "asc" },
        })
      ).map((row) => row.idempotencyKey),
    ).toEqual(["receipt-at-boundary", "reservation-ancient"]);
    expect(await f.db.projectApiAuditEvent.count()).toBe(2);
    expect(await pruneProjectApiRecords(f.db, NOW)).toEqual({
      operations: 0,
      audits: 0,
      rateWindows: 0,
    });
  });

  it("deletes at most 5,000 rows per table per run, oldest first", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, []);
    const base = auditEvent(f, k.keyId);
    await f.db.projectApiAuditEvent.createMany({
      data: Array.from({ length: 5_001 }, (_, i) => ({
        ...base,
        requestId: `req-${i}`,
        createdAt: ago(100 * DAY + (5_001 - i) * 1_000),
      })),
    });
    expect(await pruneProjectApiRecords(f.db, NOW)).toMatchObject({
      audits: 5_000,
    });
    expect(
      (await f.db.projectApiAuditEvent.findMany()).map((e) => e.requestId),
    ).toEqual(["req-5000"]);
    expect(await pruneProjectApiRecords(f.db, NOW)).toMatchObject({
      audits: 1,
    });
  });

  it("skips locked rows and lets only one cleanup run at a time", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, []);
    await operationRows(f, k.keyId, [
      { key: "locked-expired-row", state: "succeeded", at: ago(60 * DAY) },
      { key: "free-expired-row", state: "succeeded", at: ago(60 * DAY) },
    ]);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    const holder = f.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ProjectApiOperation" WHERE "idempotencyKey" = 'locked-expired-row' FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await lockHeld;
    expect(await pruneProjectApiRecords(f.db, NOW)).toMatchObject({
      operations: 1,
    });
    release();
    await holder;
    expect(
      (await f.db.projectApiOperation.findMany()).map(
        (row) => row.idempotencyKey,
      ),
    ).toEqual(["locked-expired-row"]);

    let releaseWinner!: () => void;
    const winnerReleased = new Promise<void>((r) => (releaseWinner = r));
    let winnerLocked!: () => void;
    const winnerHeld = new Promise<void>((r) => (winnerLocked = r));
    const winner = f.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('weaver:project-api-retention'))`;
        winnerLocked();
        await winnerReleased;
      },
      { timeout: 20_000 },
    );
    await winnerHeld;
    let settled = false;
    const loser = pruneProjectApiRecords(f.db, NOW).finally(
      () => (settled = true),
    );
    await sleep(100);
    expect(settled).toBe(true);
    expect(await loser).toEqual({ operations: 0, audits: 0, rateWindows: 0 });
    releaseWinner();
    await winner;
    expect(await f.db.projectApiOperation.count()).toBe(1);
  });

  it("rejects audit fields beyond the bounded metadata", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, []);
    const event = auditEvent(f, k.keyId);
    for (const extra of [
      { body: "secret" },
      { authorization: "Bearer x" },
      { requestId: "x".repeat(65) },
      { commitSha: "not-a-sha" },
    ])
      await expect(
        recordProjectApiAudit(f.db, { ...event, ...extra } as typeof event),
      ).rejects.toThrow();
    expect(await f.db.projectApiAuditEvent.count()).toBe(0);
  });

  it("audits every authenticated request with metadata only, including unconfirmed receipts", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      { kind: "table", targetId: f.table.id, root: false, actions: ["create"] },
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const rowsUrl = `http://localhost/api/v1/projects/${f.project.id}/tables/${f.table.id}/rows`;
    const rowParams = {
      params: Promise.resolve({ projectId: f.project.id, tableId: f.table.id }),
    };
    const column = f.table.columns[0]!.id;
    const append = (ifMatch: string, key: string) =>
      appendRows(
        new Request(rowsUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${k.secret}`,
            "Content-Type": "application/json",
            "If-Match": ifMatch,
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            rows: [{ cells: { [column]: "distinctive-cell-secret" } }],
          }),
        }),
        rowParams,
      );
    const accepted = await append(
      `"${f.table.headCommitSha}"`,
      "append-rows-0001",
    );
    expect(accepted.status).toBe(200);
    const stale = await append(
      `"${f.table.headCommitSha}"`,
      "append-rows-0002",
    );
    expect(stale.status).toBe(412);

    const documentUrl = `http://localhost/api/v1/projects/${f.project.id}/documents/${f.document.id}`;
    const documentParams = {
      params: Promise.resolve({
        projectId: f.project.id,
        documentId: f.document.id,
      }),
    };
    const spy = vi
      .spyOn(appDb.projectApiOperation, "update")
      .mockRejectedValueOnce(new Error("simulated acknowledgement failure"));
    const unconfirmed = await replaceDocument(
      new Request(documentUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${k.secret}`,
          "Content-Type": "application/json",
          "If-Match": `"${f.document.headCommitSha}"`,
          "Idempotency-Key": "replace-report-0001",
        },
        body: JSON.stringify({ markdown: "distinctive-markdown-secret" }),
      }),
      documentParams,
    );
    spy.mockRestore();
    expect(unconfirmed.status).toBe(500);
    expect(await unconfirmed.text()).not.toContain("acknowledgement");

    const forged = `wvr_project_${k.keyId}.${"A".repeat(43)}`;
    const unauthorized = await appendRows(
      new Request(rowsUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${forged}` },
      }),
      rowParams,
    );
    expect(unauthorized.status).toBe(401);

    const audits = await f.db.projectApiAuditEvent.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => [a.operation, a.status, a.outcome])).toEqual([
      ["rows.append", 200, "succeeded"],
      ["rows.append", 412, "rejected"],
      ["document.replace", 500, "failed"],
    ]);
    const reserved = await f.db.projectApiOperation.findFirstOrThrow({
      where: { idempotencyKey: "replace-report-0001" },
    });
    expect(reserved.state).toBe("reserved");
    expect(audits[2]).toMatchObject({
      resourceId: f.document.id,
      commitSha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(audits[0]!.commitSha).toMatch(/^[a-f0-9]{40}$/);
    const stored = JSON.stringify(audits);
    for (const secret of [
      k.secret,
      forged,
      "distinctive-cell-secret",
      "distinctive-markdown-secret",
    ])
      expect(stored).not.toContain(secret);
  });
});
