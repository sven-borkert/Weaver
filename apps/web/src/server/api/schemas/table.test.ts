import { expect, it } from "vitest";
import {
  createTableInput,
  restoreTableInput,
  deleteTableInput,
  tableHistoryInput,
} from "./table";
import { restoreInput } from "./document";
const projectId = "00000000-0000-4000-8000-000000000000";
it.each(["bad\0title", "bad\u2028title", "bad\u2029title"])(
  "rejects unsafe table title %j",
  (title) => {
    expect(
      createTableInput.safeParse({ projectId, folderPath: [], title }).success,
    ).toBe(false);
  },
);
it("requires the viewed content version for destructive writes", () => {
  expect(
    restoreTableInput.safeParse({
      projectId,
      tableId: projectId,
      sha: "a".repeat(40),
    }).success,
  ).toBe(false);
  expect(
    deleteTableInput.safeParse({ projectId, tableId: projectId }).success,
  ).toBe(false);
  expect(
    restoreInput.safeParse({
      projectId,
      documentId: projectId,
      sha: "a".repeat(40),
    }).success,
  ).toBe(false);
});
it("caps table history pagination", () => {
  expect(
    tableHistoryInput.safeParse({ projectId, tableId: projectId, offset: 1001 })
      .success,
  ).toBe(false);
});
