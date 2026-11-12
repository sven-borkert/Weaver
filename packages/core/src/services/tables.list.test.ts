import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "../security/context";
import { listTables } from "./tables";

it("caps legacy All table listings and exposes continuation pages", async () => {
  const records = Array.from({ length: 205 }, (_, i) => ({
    id: String(i),
    title: `Table ${i}`,
    appearance: null,
  }));
  const findMany = vi.fn(async (args: { skip?: number; take?: number }) =>
    records.slice(
      args.skip ?? 0,
      args.take === undefined ? undefined : (args.skip ?? 0) + args.take,
    ),
  );
  const db = {
    project: {
      findFirst: async () => ({
        id: "project",
        organizationId: "org",
        organization: { members: [{ role: "viewer" }] },
      }),
    },
    dataTable: { count: async () => records.length, findMany },
  } as unknown as PrismaClient;
  const actor = createSessionSecurityContext({
    userId: "viewer",
    globalRole: "User",
    sessionId: "session",
  });
  const input = {
    projectId: "project",
    page: 1,
    pageSize: -1,
    sort: "title" as const,
    dir: "asc" as const,
  };
  const first = await listTables(db, input, actor);
  expect(first.items).toHaveLength(200);
  expect(first).toMatchObject({ total: 205, pageCount: 2, pageSize: 200 });
  const second = await listTables(db, { ...input, page: 2 }, actor);
  expect(second.items.map((row) => row.id)).toEqual(
    records.slice(200).map((row) => row.id),
  );
});
