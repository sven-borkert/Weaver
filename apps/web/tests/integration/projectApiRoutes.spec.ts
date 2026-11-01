import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeProjectApiOperationPool } from "@weaver/core/projectApi/operationLock";
import { GET as getGrants } from "../../src/app/api/v1/projects/[projectId]/grants/route";
import {
  GET as listDocuments,
  POST as createDocument,
} from "../../src/app/api/v1/projects/[projectId]/documents/route";
import {
  DELETE as deleteDocument,
  GET as getDocument,
  HEAD as headDocument,
} from "../../src/app/api/v1/projects/[projectId]/documents/[documentId]/route";
import { POST as createTable } from "../../src/app/api/v1/projects/[projectId]/tables/route";
import {
  DELETE as deleteTable,
  GET as getTable,
} from "../../src/app/api/v1/projects/[projectId]/tables/[tableId]/route";
import { PATCH as updateRows } from "../../src/app/api/v1/projects/[projectId]/tables/[tableId]/rows/route";
import { DELETE as deleteRow } from "../../src/app/api/v1/projects/[projectId]/tables/[tableId]/rows/[rowId]/route";
import {
  makeMachineFixture,
  seedProjectMachineKey,
  type MachineFixture,
} from "./_projectApiHarness";
import { resetDb } from "./_harness";

type Params = Record<string, string>;
type Handler = (
  req: Request,
  context: { params: Promise<never> },
) => Promise<Response>;

function call(
  handler: unknown,
  f: MachineFixture,
  secret: string,
  path: string,
  params: Params,
  init: {
    method: string;
    body?: unknown;
    ifMatch?: string;
    key?: string;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    ...(init.ifMatch ? { "If-Match": init.ifMatch } : {}),
    ...(init.key ? { "Idempotency-Key": init.key } : {}),
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...init.headers,
  };
  const bodiless =
    init.body === undefined && !["GET", "HEAD"].includes(init.method);
  const request = new Request(
    `http://localhost/api/v1/projects/${f.project.id}${path}`,
    {
      method: init.method,
      headers,
      // Next hands route handlers a non-null stream for every non-GET/HEAD request.
      body: bodiless
        ? new ReadableStream({ start: (controller) => controller.close() })
        : init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
      ...(bodiless ? { duplex: "half" } : {}),
    } as RequestInit,
  );
  return (handler as Handler)(request, {
    params: Promise.resolve({ projectId: f.project.id, ...params }) as never,
  });
}

describe("project machine API routes", () => {
  beforeEach(resetDb);
  afterAll(closeProjectApiOperationPool);

  it("creates a dated report, replays it, refuses a changed retry and lists readable documents", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create", "read"],
      },
    ]);
    const report = {
      title: "Daily audit 2026-10-14",
      folder: { root: true },
      markdown: "All accounts reviewed",
    };
    const created = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        body: report,
        key: "daily-audit-2026-10-14",
      },
    );
    expect(created.status).toBe(201);
    const receipt = (await created.json()) as {
      resourceId: string;
      replayed: boolean;
    };
    expect(receipt.replayed).toBe(false);
    const replay = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        body: report,
        key: "daily-audit-2026-10-14",
      },
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      resourceId: receipt.resourceId,
      replayed: true,
    });
    const changed = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        body: { ...report, markdown: "Different" },
        key: "daily-audit-2026-10-14",
      },
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" },
    });

    const first = await call(
      listDocuments,
      f,
      k.secret,
      "/documents?limit=1",
      {},
      { method: "GET" },
    );
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await call(
      listDocuments,
      f,
      k.secret,
      `/documents?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
      {},
      { method: "GET" },
    );
    const rest = (await second.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect([...page.items, ...rest.items].map((i) => i.id).sort()).toEqual(
      [f.document.id, receipt.resourceId].sort(),
    );
    expect(rest.nextCursor).toBeNull();

    const grants = await call(
      getGrants,
      f,
      k.secret,
      "/grants",
      {},
      { method: "GET" },
    );
    expect(await grants.json()).toEqual({
      grants: [
        expect.objectContaining({
          kind: "documentFolder",
          root: true,
          available: true,
          actions: ["read", "create"],
        }),
      ],
    });
  });

  it("deletes documents with revision preconditions through the real handler", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "document",
        targetId: f.document.id,
        root: false,
        actions: ["delete"],
      },
    ]);
    const path = `/documents/${f.document.id}`;
    const params = { documentId: f.document.id };
    const missing = await call(deleteDocument, f, k.secret, path, params, {
      method: "DELETE",
      key: "delete-latest-audit",
    });
    expect(missing.status).toBe(428);
    const stale = await call(deleteDocument, f, k.secret, path, params, {
      method: "DELETE",
      key: "delete-latest-audit-2",
      ifMatch: `"${"0".repeat(40)}"`,
    });
    expect(stale.status).toBe(412);
    const head = await call(headDocument, f, k.secret, path, params, {
      method: "HEAD",
    });
    const deleted = await call(deleteDocument, f, k.secret, path, params, {
      method: "DELETE",
      key: "delete-latest-audit-3",
      ifMatch: head.headers.get("etag")!,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ resourceId: f.document.id });
    expect(
      (await call(getDocument, f, k.secret, path, params, { method: "GET" }))
        .status,
    ).toBe(404);
    const withBody = await call(deleteDocument, f, k.secret, path, params, {
      method: "DELETE",
      key: "delete-with-a-body",
      ifMatch: head.headers.get("etag")!,
      body: {},
    });
    expect(withBody.status).toBe(400);
  });

  it("creates a table, updates and deletes rows, then deletes the table", async () => {
    const f = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "tableFolder",
        targetId: null,
        root: true,
        actions: ["read", "create", "update", "delete"],
      },
    ]);
    const columnId = randomUUID();
    const created = await call(
      createTable,
      f,
      k.secret,
      "/tables",
      {},
      {
        method: "POST",
        key: "create-results-table",
        body: {
          title: "Weekly results",
          folder: { root: true },
          columns: [{ id: columnId, name: "Account", type: "text" }],
          rows: [{ cells: { [columnId]: "alice" } }],
        },
      },
    );
    expect(created.status).toBe(201);
    const receipt = (await created.json()) as {
      resourceId: string;
      revision: string;
      generatedIds: { columnIds: string[]; rowIds: string[] };
    };
    expect(receipt.generatedIds.columnIds).toEqual([columnId]);
    const rowId = receipt.generatedIds.rowIds[0]!;
    const params = { tableId: receipt.resourceId };
    const tablePath = `/tables/${receipt.resourceId}`;
    const patched = await call(
      updateRows,
      f,
      k.secret,
      `${tablePath}/rows`,
      params,
      {
        method: "PATCH",
        key: "rename-alice-row",
        ifMatch: `"${receipt.revision}"`,
        body: { rows: [{ rowId, set: { [columnId]: "bob" } }] },
      },
    );
    expect(patched.status).toBe(200);
    const afterPatch = (await patched.json()) as { revision: string };
    const table = await call(getTable, f, k.secret, tablePath, params, {
      method: "GET",
    });
    expect(await table.json()).toMatchObject({
      rows: [{ id: rowId, cells: { [columnId]: "bob" } }],
    });
    const rowDeleted = await call(
      deleteRow,
      f,
      k.secret,
      `${tablePath}/rows/${rowId}`,
      { ...params, rowId },
      {
        method: "DELETE",
        key: "delete-bob-row",
        ifMatch: `"${afterPatch.revision}"`,
      },
    );
    expect(rowDeleted.status).toBe(200);
    const afterRow = (await rowDeleted.json()) as { revision: string };
    const tableDeleted = await call(
      deleteTable,
      f,
      k.secret,
      tablePath,
      params,
      {
        method: "DELETE",
        key: "delete-weekly-results",
        ifMatch: `"${afterRow.revision}"`,
      },
    );
    expect(tableDeleted.status).toBe(200);
    expect(
      (await call(getTable, f, k.secret, tablePath, params, { method: "GET" }))
        .status,
    ).toBe(404);
  });

  it("maps transport and resource errors to their documented statuses", async () => {
    const f = await makeMachineFixture();
    const other = await makeMachineFixture();
    const k = await seedProjectMachineKey(f, [
      {
        kind: "documentFolder",
        targetId: null,
        root: true,
        actions: ["create", "read"],
      },
    ]);
    const wrongType = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        key: "wrong-content-type",
        body: { title: "x", folder: { root: true }, markdown: "x" },
        headers: { "Content-Type": "text/plain" },
      },
    );
    expect(wrongType.status).toBe(415);
    const tooLarge = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        key: "declared-too-large",
        body: { title: "x", folder: { root: true }, markdown: "x" },
        headers: { "Content-Length": String(6 * 1024 ** 2) },
      },
    );
    expect(tooLarge.status).toBe(413);
    const noKey = await call(
      createDocument,
      f,
      k.secret,
      "/documents",
      {},
      {
        method: "POST",
        body: { title: "x", folder: { root: true }, markdown: "x" },
      },
    );
    expect(noKey.status).toBe(400);
    const foreign = await call(
      getDocument,
      f,
      k.secret,
      `/documents/${other.document.id}`,
      { documentId: other.document.id },
      { method: "GET" },
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
