import type { JSONContent } from "@tiptap/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";
import { openProjectRepo } from "@weaver/git-store";

async function setup(suffix: string) {
  const owner = await makeUser("User", `tx-owner-${suffix}`);
  const project = await makeProject(`TX-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  return { project, caller: callerFor(owner), owner };
}

const docWithTableRef = (tableId: string): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "crossref",
          attrs: { targetType: "table", targetId: tableId, label: null },
        },
      ],
    },
  ],
});

describe("document → table cross-references", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("serializes weaver://table links with resolved titles", async () => {
    const { project, caller } = await setup("1");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const doc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: docWithTableRef(table.id),
    });
    const repo = (await openProjectRepo(project.id))!;
    const file = (await repo.readCommittedFile(doc.path))!.content;
    expect(file).toContain(`[Budget](weaver://table/${table.id})`);
  });

  it("records DocumentLink rows with targetType table", async () => {
    const { project, caller } = await setup("2");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const doc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: docWithTableRef(table.id),
    });
    const links = await getPrisma().documentLink.findMany({
      where: { sourceDocumentId: doc.id },
    });
    expect(links).toEqual([
      expect.objectContaining({
        targetDocumentId: table.id,
        targetType: "table",
      }),
    ]);
  });

  it("resolves mixed refs and lists table backlinks", async () => {
    const { project, caller } = await setup("3");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const otherDoc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Other",
      contentJson: { type: "doc" },
    });
    const doc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "crossref",
                attrs: {
                  targetType: "table",
                  targetId: table.id,
                  label: null,
                },
              },
              {
                type: "crossref",
                attrs: { targetId: otherDoc.id, label: null },
              },
            ],
          },
        ],
      },
    });
    const resolved = await caller.document.resolveRefs({
      projectId: project.id,
      ids: [table.id, otherDoc.id, "99999999-9999-4999-8999-999999999999"],
    });
    expect(resolved[0]).toMatchObject({
      id: table.id,
      exists: true,
      targetType: "table",
      title: "Budget",
    });
    expect(resolved[1]).toMatchObject({
      id: otherDoc.id,
      exists: true,
      targetType: "document",
    });
    expect(resolved[2]).toMatchObject({ exists: false });

    const backlinks = await caller.table.backlinks({
      projectId: project.id,
      tableId: table.id,
    });
    expect(backlinks.map((entry) => entry.id)).toEqual([doc.id]);
  });

  it("filters table backlinks by target type and project in stable order", async () => {
    const { project, caller } = await setup("4");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const sourceZ = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Z source",
      contentJson: docWithTableRef(table.id),
    });
    const sourceA = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "A source",
      contentJson: docWithTableRef(table.id),
    });
    const documentOnly = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Document only",
      contentJson: { type: "doc" },
    });
    await getPrisma().documentLink.create({
      data: {
        sourceDocumentId: documentOnly.id,
        targetDocumentId: table.id,
        targetType: "document",
      },
    });
    const foreign = await setup("4-foreign");
    const foreignSource = await foreign.caller.document.create({
      projectId: foreign.project.id,
      folderPath: [],
      title: "Foreign source",
      contentJson: { type: "doc" },
    });
    await getPrisma().documentLink.create({
      data: {
        sourceDocumentId: foreignSource.id,
        targetDocumentId: table.id,
        targetType: "table",
      },
    });

    const backlinks = await caller.table.backlinks({
      projectId: project.id,
      tableId: table.id,
    });

    expect(backlinks.map((entry) => entry.id)).toEqual([
      sourceA.id,
      sourceZ.id,
    ]);
  });

  it("validates Viewer access and current same-project Git truth", async () => {
    const { project, caller } = await setup("5");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const viewer = await makeUser("User", "tx-viewer-5");
    await addMembership(project.id, viewer.id, "Viewer");
    await expect(
      callerFor(viewer).table.backlinks({
        projectId: project.id,
        tableId: table.id,
      }),
    ).resolves.toEqual([]);

    const outsider = await makeUser("User", "tx-outsider-5");
    await expect(
      callerFor(outsider).table.backlinks({
        projectId: project.id,
        tableId: table.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await caller.table.delete({
      projectId: project.id,
      tableId: table.id,
      expectedHeadCommitSha: table.headCommitSha,
    });
    await expect(
      caller.table.backlinks({ projectId: project.id, tableId: table.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps document backlinks document-only", async () => {
    const { project, caller } = await setup("6");
    const table = await caller.table.create({
      projectId: project.id,
      folderPath: [],
      title: "Budget",
    });
    const doc = await caller.document.create({
      projectId: project.id,
      folderPath: [],
      title: "Notes",
      contentJson: docWithTableRef(table.id),
    });
    const docBacklinks = await caller.document.backlinks({
      projectId: project.id,
      documentId: doc.id,
    });
    expect(docBacklinks).toEqual({ documents: [], nextCursor: null });
  });
});
