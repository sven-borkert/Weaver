import { describe, expect, it } from "vitest";

import {
  acceptedTableWriteState,
  refreshAfterAcceptedTableWrite,
} from "./save";
import type { TableData } from "@weaver/core/tables/types";

const ROW_1 = "11111111-1111-4111-8111-111111111111";
const ROW_2 = "22222222-2222-4222-8222-222222222222";
const COLUMN_AMOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COLUMN_NOTES = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRE_SAVE_SHA = "a".repeat(40);

const acceptedResponses: Array<{
  name: string;
  result: TableData & {
    id: string;
    path: string;
    slug: string;
    headCommitSha: string;
  };
}> = [
  {
    name: "normal",
    result: {
      id: "33333333-3333-4333-8333-333333333333",
      path: "tables/budget.table",
      slug: "budget",
      title: "Budget saved",
      columns: [{ id: COLUMN_AMOUNT, name: "Amount", type: "number" as const }],
      rows: [{ id: ROW_1, cells: { [COLUMN_AMOUNT]: 42 } }],
      headCommitSha: "b".repeat(40),
    },
  },
  {
    name: "merged",
    result: {
      id: "33333333-3333-4333-8333-333333333333",
      path: "tables/merged-budget.table",
      slug: "merged-budget",
      title: "Merged budget",
      columns: [
        { id: COLUMN_AMOUNT, name: "Amount", type: "number" as const },
        { id: COLUMN_NOTES, name: "Notes", type: "text" as const },
      ],
      rows: [
        { id: ROW_1, cells: { [COLUMN_AMOUNT]: 42 } },
        { id: ROW_2, cells: { [COLUMN_NOTES]: "Merged from server" } },
      ],
      headCommitSha: "c".repeat(40),
    },
  },
];

describe("accepted table writes", () => {
  it.each(acceptedResponses)(
    "keeps the exact $name response accepted when cache refresh rejects",
    async ({ result }) => {
      const accepted = acceptedTableWriteState(result, PRE_SAVE_SHA);

      await expect(
        refreshAfterAcceptedTableWrite(() =>
          Promise.reject(new Error("refresh failed")),
        ),
      ).resolves.toBe("failed");
      expect(accepted).toEqual({
        snapshot: {
          title: result.title,
          columns: result.columns,
          rows: result.rows,
          baseCommitSha: result.headCommitSha,
        },
        draft: {
          title: result.title,
          columns: result.columns,
          rows: result.rows,
        },
        staleIncomingBaseCommitSha: PRE_SAVE_SHA,
      });
    },
  );

  it("reports a successful cache refresh", async () => {
    await expect(
      refreshAfterAcceptedTableWrite(() => Promise.resolve()),
    ).resolves.toBe("refreshed");
  });
});
