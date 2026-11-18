import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo, type ProjectRepoReader } from "@weaver/git-store";
import { expect, it, vi } from "vitest";
import { createTaskSecurityContext } from "../security/context";
import { getDiff, getDocument } from "../services/documents";
import {
  projectChangesSince,
  type ProjectChange,
} from "../services/projectActivity";
import { getTable } from "../services/tables";
import { assembleTaskContext } from "./context";

vi.mock("@weaver/git-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openProjectRepo: vi.fn(),
}));
vi.mock("../services/documents", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDiff: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock("../services/projectActivity", () => ({
  projectChangesSince: vi.fn(),
}));
vi.mock("../services/tables", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTable: vi.fn(),
}));

const document = {
  id: "document",
  title: "Selected document",
  path: "selected.md",
  status: "M",
};
const outsideDocument = {
  id: "outside-document",
  title: "Outside document",
  path: "outside.md",
  status: "M",
};
const table = {
  id: "table",
  title: "Selected table",
  path: "tables/selected.table",
  status: "M",
};
const outsideTable = {
  id: "outside-table",
  title: "Outside table",
  path: "tables/outside.table",
  status: "M",
};
const date = new Date("2026-11-18T10:00:00Z");
const commit = (changes: Partial<ProjectChange>): ProjectChange => ({
  authorName: "Editor",
  sha: "mixed",
  date,
  documents: [],
  tables: [],
  message: "Mixed commit message",
  changeSummary: { status: "ready", summary: "Mixed commit summary" },
  ...changes,
});

it.each(["document", "table"] as const)(
  "limits the prompt context to the selected %s",
  async (kind) => {
    vi.clearAllMocks();
    const filtered =
      kind === "document" ? { documents: [document] } : { tables: [table] };
    vi.mocked(projectChangesSince).mockResolvedValue({
      fallback: "none",
      headSha: "head",
      truncated: false,
      commits: [
        commit({
          sha: "other",
          documents: [outsideDocument],
          tables: [outsideTable],
          message: "Other commit message",
        }),
        commit({
          documents: [document, outsideDocument],
          tables: [table, outsideTable],
        }),
        commit({
          ...filtered,
          sha: "selected",
          message: "Selected commit message",
          changeSummary: {
            status: "ready",
            summary: "Selected commit summary",
          },
        }),
      ],
    });
    vi.mocked(getDocument).mockResolvedValue({
      title: document.title,
      content: { kind: "python", text: "Selected current content" },
    } as Awaited<ReturnType<typeof getDocument>>);
    vi.mocked(getTable).mockResolvedValue({
      title: table.title,
      columns: [],
      rows: [],
    } as unknown as Awaited<ReturnType<typeof getTable>>);
    vi.mocked(openProjectRepo).mockResolvedValue({
      logForPath: async () => [{ sha: "selected" }, { sha: "parent" }],
    } as unknown as ProjectRepoReader);
    vi.mocked(getDiff).mockImplementation(async (_db, { documentId }) => ({
      lines: [
        {
          type: "add",
          text:
            documentId === document.id
              ? "Selected diff text"
              : "Outside diff text",
        },
      ],
    }));

    const actor = createTaskSecurityContext({
      userId: "user",
      globalRole: "User",
      runId: "run",
    });
    const db = {
      project: { findFirst: async () => ({ name: "Project" }) },
    } as unknown as PrismaClient;
    const context = await assembleTaskContext(db, actor, {
      scope: {
        kind,
        projectIds: ["project"],
        documentId: kind === "document" ? document.id : null,
        tableId: kind === "table" ? table.id : null,
        resolvedAt: date.toISOString(),
        truncated: false,
      },
      excludeDocumentId: null,
      previousHeads: null,
      inputBytes: 20_000,
      now: date,
    });

    const promptContent = `${context.digest}\n${context.content}`;
    expect(promptContent).toContain(`Selected ${kind} (modified)`);
    expect(promptContent).toContain("Selected commit message");
    expect(promptContent).toContain("Selected commit summary");
    expect(promptContent).not.toMatch(/Outside|Other commit|Mixed commit/u);
    expect(promptContent).not.toContain(
      kind === "document" ? table.title : document.title,
    );
    expect(context.summary.commits).toBe(2);
    if (kind === "document") {
      expect(promptContent).toContain("Selected diff text");
      expect(
        vi.mocked(getDiff).mock.calls.map(([, input]) => input.documentId),
      ).toEqual([document.id]);
    } else {
      expect(getDiff).not.toHaveBeenCalled();
    }
  },
);
