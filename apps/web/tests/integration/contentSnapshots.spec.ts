import { beforeEach, describe, expect, it } from "vitest";
import { isCoreError } from "@weaver/core/errors";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocument,
  getDocumentAtSnapshot,
  saveDocument,
} from "@weaver/core/services/documents";
import {
  createTable,
  getTableAtSnapshot,
  saveTable,
} from "@weaver/core/services/tables";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
} from "./_harness";

const COL = "11111111-1111-4111-8111-111111111111";
const ROW = "33333333-3333-4333-8333-333333333333";

async function fixture() {
  const db = getPrisma();
  const user = await makeUser("User", "snapshots");
  const outsider = await makeUser("User", "snapshots-outsider");
  const project = await makeProject("Snapshots");
  await addMembership(project.id, user.id, "Editor");
  const actor = {
    ...securityContextFor(user),
    name: "Snap",
    email: user.email,
  };
  const doc = await createDocument(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody("# Notes\n\nfirst\n"),
      },
    },
    actor,
  );
  const table = await createTable(
    db,
    {
      projectId: project.id,
      folderPath: [],
      title: "Items",
      columns: [{ id: COL, name: "Name", type: "text" }],
      rows: [{ id: ROW, cells: { [COL]: "one" } }],
    },
    actor,
  );
  return { db, user, outsider, project, actor, doc, table };
}

async function coreReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return isCoreError(error)
      ? `${error.code}:${String(error.details?.reason)}`
      : "not core";
  }
}

describe("content snapshot readers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reads a document at HEAD and at an older pinned snapshot with distinct revisions", async () => {
    const { db, project, actor, doc } = await fixture();
    const v1 = doc.headCommitSha;
    const v2 = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: v1,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Notes\n\nsecond\n"),
        },
        changeSummary: "edit",
      },
      actor,
    );
    const live = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: doc.id },
      actor,
    );
    expect(live).toMatchObject({
      id: doc.id,
      snapshotCommitSha: v2.headCommitSha,
      baseCommitSha: v2.headCommitSha,
    });
    expect(live.markdown).toContain("second");

    const pinned = await getDocumentAtSnapshot(
      db,
      { projectId: project.id, documentId: doc.id, atCommitSha: v1 },
      actor,
    );
    expect(pinned).toMatchObject({ snapshotCommitSha: v1, baseCommitSha: v1 });
    expect(pinned.markdown).toContain("first");
    expect(pinned.markdown).not.toContain("second");
  });

  it("distinguishes the project snapshot from the resource base when an unrelated item changes", async () => {
    const { db, project, actor, doc, table } = await fixture();
    const edited = await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: doc.id,
        baseCommitSha: doc.headCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Notes\n\nchanged\n"),
        },
        changeSummary: "edit",
      },
      actor,
    );
    const read = await getTableAtSnapshot(
      db,
      { projectId: project.id, tableId: table.id },
      actor,
    );
    expect(read.snapshotCommitSha).toBe(edited.headCommitSha);
    expect(read.baseCommitSha).toBe(table.headCommitSha);
    expect(read.rows).toEqual([{ id: ROW, cells: { [COL]: "one" } }]);
  });

  it("reads an older table version and never substitutes current rows", async () => {
    const { db, project, actor, table } = await fixture();
    const v1 = table.headCommitSha;
    await saveTable(
      db,
      {
        projectId: project.id,
        tableId: table.id,
        baseCommitSha: v1,
        columns: table.columns,
        rows: [{ id: ROW, cells: { [COL]: "two" } }],
      },
      actor,
    );
    const pinned = await getTableAtSnapshot(
      db,
      { projectId: project.id, tableId: table.id, atCommitSha: v1 },
      actor,
    );
    expect(pinned.rows[0]?.cells[COL]).toBe("one");
    expect(pinned.baseCommitSha).toBe(v1);
  });

  it("rejects unreachable, malformed, and foreign snapshots as SNAPSHOT_UNAVAILABLE", async () => {
    const { db, user, project, actor, doc, table } = await fixture();
    const other = await makeProject("Other");
    await addMembership(other.id, user.id, "Editor");
    const foreign = await createDocument(
      db,
      {
        projectId: other.id,
        folderPath: [],
        title: "Foreign",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("# Foreign\n"),
        },
      },
      actor,
    );
    const unavailable = "NOT_FOUND:SNAPSHOT_UNAVAILABLE";
    expect(
      await coreReason(
        getDocumentAtSnapshot(
          db,
          {
            projectId: project.id,
            documentId: doc.id,
            atCommitSha: "f".repeat(40),
          },
          actor,
        ),
      ),
    ).toBe(unavailable);
    expect(
      await coreReason(
        getDocumentAtSnapshot(
          db,
          { projectId: project.id, documentId: doc.id, atCommitSha: "HEAD" },
          actor,
        ),
      ),
    ).toBe(unavailable);
    expect(
      await coreReason(
        getTableAtSnapshot(
          db,
          {
            projectId: project.id,
            tableId: table.id,
            atCommitSha: foreign.headCommitSha,
          },
          actor,
        ),
      ),
    ).toBe(unavailable);
  });

  it("requires membership regardless of snapshot", async () => {
    const { db, project, outsider, doc } = await fixture();
    const stranger = {
      ...securityContextFor(outsider),
      name: "Out",
      email: outsider.email,
    };
    expect(
      await coreReason(
        getDocumentAtSnapshot(
          db,
          {
            projectId: project.id,
            documentId: doc.id,
            atCommitSha: doc.headCommitSha,
          },
          stranger,
        ),
      ),
    ).toMatch(/^(NOT_FOUND|FORBIDDEN):/);
  });
});
