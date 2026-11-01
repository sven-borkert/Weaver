import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import {
  assertLifecycleShape,
  contentOperationSchema,
  type ContentOperation,
} from "./contentOperations";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);

const lifecycle = (
  extra: Partial<Extract<ContentOperation, { kind: "content.lifecycle" }>>,
): ContentOperation =>
  ({
    kind: "content.lifecycle",
    projectId: PROJECT,
    resourceType: "document",
    ...extra,
  }) as ContentOperation;

describe("content.lifecycle schema", () => {
  it("sits at index 8 in the union, so persisted operations keep parsing", () => {
    const kinds = contentOperationSchema.options.map(
      (option) => option.shape.kind.value,
    );
    // Pinned by index, not by being last: later slices append after it, and no
    // existing variant may shift (a persisted proposal is parsed by position in
    // the union's discriminator).
    expect(kinds.indexOf("content.lifecycle")).toBe(8);
    expect(kinds.slice(0, 8)).toEqual([
      "document.create",
      "document.edit",
      "document.patch",
      "table.create",
      "table.schema",
      "table.rows",
      "table.change",
      "content.restore",
    ]);
  });

  it("rejects a root path, so a root can never be renamed, moved or deleted", () => {
    const parsed = contentOperationSchema.safeParse(
      lifecycle({
        action: "folder_delete",
        baseProjectCommitSha: SHA,
        path: [],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts an empty parentPath, so a top-level folder can be created", () => {
    expect(
      contentOperationSchema.safeParse(
        lifecycle({
          action: "folder_create",
          baseProjectCommitSha: SHA,
          parentPath: [],
          name: "Archive",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("assertLifecycleShape", () => {
  it("passes every action given exactly its own fields", () => {
    const valid: ContentOperation[] = [
      lifecycle({
        action: "folder_create",
        baseProjectCommitSha: SHA,
        parentPath: [],
        name: "Archive",
      }),
      lifecycle({
        action: "folder_rename",
        baseProjectCommitSha: SHA,
        path: ["archive"],
        name: "Old",
      }),
      lifecycle({
        action: "folder_move",
        baseProjectCommitSha: SHA,
        path: ["archive"],
        newParentPath: ["store"],
      }),
      lifecycle({
        action: "folder_delete",
        baseProjectCommitSha: SHA,
        path: ["archive"],
      }),
      lifecycle({
        action: "item_move",
        resourceId: RESOURCE,
        expectedHeadCommitSha: SHA,
        folderPath: ["archive"],
      }),
      lifecycle({
        action: "item_delete",
        resourceId: RESOURCE,
        expectedHeadCommitSha: SHA,
      }),
    ];
    for (const operation of valid)
      expect(() => assertLifecycleShape(operation)).not.toThrow();
  });

  it("names the missing field when an action's guard is absent", () => {
    expect(() =>
      assertLifecycleShape(
        lifecycle({ action: "item_delete", resourceId: RESOURCE }),
      ),
    ).toThrow(/expectedHeadCommitSha/);
    expect(() =>
      assertLifecycleShape(
        lifecycle({ action: "folder_delete", path: ["archive"] }),
      ),
    ).toThrow(/baseProjectCommitSha/);
  });

  it("names a field that does not belong to the action", () => {
    let thrown: unknown;
    try {
      assertLifecycleShape(
        lifecycle({
          action: "folder_delete",
          baseProjectCommitSha: SHA,
          path: ["archive"],
          name: "stray",
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).code).toBe("BAD_REQUEST");
    expect((thrown as CoreError).details).toMatchObject({ field: "name" });
    expect((thrown as CoreError).message).toMatch(/does not accept name/);
  });

  it("rejects an item guard on a folder action and vice versa", () => {
    expect(() =>
      assertLifecycleShape(
        lifecycle({
          action: "folder_delete",
          baseProjectCommitSha: SHA,
          path: ["archive"],
          expectedHeadCommitSha: SHA,
        }),
      ),
    ).toThrow(/does not accept expectedHeadCommitSha/);
    expect(() =>
      assertLifecycleShape(
        lifecycle({
          action: "item_delete",
          resourceId: RESOURCE,
          expectedHeadCommitSha: SHA,
          baseProjectCommitSha: SHA,
        }),
      ),
    ).toThrow(/does not accept baseProjectCommitSha/);
  });

  it("ignores operations of every other kind", () => {
    expect(() =>
      assertLifecycleShape({
        kind: "document.create",
        projectId: PROJECT,
        folderPath: [],
        title: "T",
        markdown: "x",
      }),
    ).not.toThrow();
  });
});
