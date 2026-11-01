import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, afterAll } from "vitest";
import {
  HEAD,
  GET,
  PUT,
} from "../../src/app/api/v1/projects/[projectId]/documents/[documentId]/route";
import {
  PATCH,
  POST,
} from "../../src/app/api/v1/projects/[projectId]/tables/[tableId]/rows/route";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
import {
  makeMachineFixture,
  seedProjectMachineKey,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";
describe("project machine HTTP API", () => {
  beforeEach(resetDb);
  afterAll(closeProjectApiOperationPool);
  it("hides ungranted tables before validating row updates", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["read"],
      },
    ]);
    const attempt = async (tableId: string) =>
      PATCH(
        new Request(
          `http://localhost/api/v1/projects/${f.project.id}/tables/${tableId}/rows`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${k.secret}`,
              "Content-Type": "application/json",
              "If-Match": `"${f.table.headCommitSha}"`,
              "Idempotency-Key": randomUUID(),
            },
            body: JSON.stringify({
              rows: [{ rowId: randomUUID(), set: {}, clear: [] }],
            }),
          },
        ),
        { params: Promise.resolve({ projectId: f.project.id, tableId }) },
      );
    expect((await attempt(f.table.id)).status).toBe(404);
    expect((await attempt(randomUUID())).status).toBe(404);
    await f.db.projectApiKeyGrant.create({
      data: {
        keyId: k.keyId,
        targetKind: "table",
        targetId: f.table.id,
        canRead: true,
      },
    });
    expect((await attempt(f.table.id)).status).toBe(403);
    await f.db.projectApiKeyGrant.updateMany({
      where: { keyId: k.keyId, targetKind: "table" },
      data: { canUpdate: true },
    });
    expect((await attempt(f.table.id)).status).toBe(400);
    expect(await f.db.projectApiOperation.count()).toBe(0);
  });
  it("serves write-only HEAD, requires project bearer credentials and publishes metadata-only receipts", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["update"],
      },
    ]);
    const url = `http://localhost/weaver/api/v1/projects/${f.project.id}/documents/${f.document.id}`;
    const params = {
      params: Promise.resolve({
        projectId: f.project.id,
        documentId: f.document.id,
      }),
    };
    const headers = { Authorization: `Bearer ${k.secret}` };
    const head = await HEAD(
      new Request(url, { method: "HEAD", headers }),
      params,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(`"${f.document.headCommitSha}"`);
    expect((await GET(new Request(url, { headers }), params)).status).toBe(403);
    expect(
      (
        await GET(
          new Request(url, { headers: { Cookie: "fake-session" } }),
          params,
        )
      ).status,
    ).toBe(401);
    const request = () =>
      new Request(url, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "If-Match": head.headers.get("etag")!,
          "Idempotency-Key": "http-audit-publish-key",
          "X-Request-Id": randomUUID(),
        },
        body: JSON.stringify({ markdown: "secret-audit-body" }),
      });
    const response = await PUT(request(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.text()).not.toContain("secret-audit-body");
    expect((await PUT(request(), params)).status).toBe(200);
    const audits = await f.db.projectApiAuditEvent.findMany({
      where: { keyId: k.keyId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audits)).not.toContain(k.secret);
    expect(JSON.stringify(audits)).not.toContain("secret-audit-body");
    const bad = await PUT(
      new Request(url, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": "invalid-extra-field-key",
        },
        body: JSON.stringify({ markdown: "private", unknown: true }),
      }),
      params,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "BAD_REQUEST", requestId: expect.any(String) },
    });
  });
  it("appends using Create only without exposing stored rows and returns retry-after for exhausted quota", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(
      f,
      [
        {
          kind: "table",
          targetId: f.table.id,
          root: false,
          actions: ["create"],
        },
      ],
      { rateLimitPerMinute: 1 },
    );
    const url = `http://localhost/api/v1/projects/${f.project.id}/tables/${f.table.id}/rows`;
    const params = {
      params: Promise.resolve({ projectId: f.project.id, tableId: f.table.id }),
    };
    const request = () =>
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${k.secret}`,
          "Content-Type": "application/json",
          "If-Match": `"${f.table.headCommitSha}"`,
          "Idempotency-Key": "http-rows-append-key",
        },
        body: JSON.stringify({
          rows: [{ cells: { [f.table.columns[0]!.id]: "New account" } }],
        }),
      });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("original-private-account");
    const limited = await POST(request(), params);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
