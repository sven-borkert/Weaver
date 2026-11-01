import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDetail } from "@weaver/core/services/ingestion";
import { FieldError, ReviewScreen } from "./ReviewScreen";

type MutationError = { data?: { field?: string } | null; message: string };
const mutations = vi.hoisted(() => ({
  acceptError: undefined as ((error: MutationError) => void) | undefined,
  updateError: undefined as ((error: MutationError) => void) | undefined,
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: mutations.toastError, success: vi.fn() },
}));

const mocked = vi.hoisted(() => {
  const query = () => ({
    data: undefined as unknown,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  });
  return {
    project: query(),
    file: query(),
    documentFolders: query(),
    tableFolders: query(),
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    project: { get: { useQuery: () => mocked.project } },
    ingestion: {
      getFile: { useQuery: () => mocked.file },
      updateDraft: {
        useMutation: (options: { onError: (error: MutationError) => void }) => {
          mutations.updateError = options.onError;
          return {
            isPending: false,
            mutate: vi.fn(),
            mutateAsync: vi.fn(),
          };
        },
      },
      accept: {
        useMutation: (options: { onError: (error: MutationError) => void }) => {
          mutations.acceptError = options.onError;
          return { isPending: false, mutate: vi.fn() };
        },
      },
      reject: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    },
    folder: { tree: { useQuery: () => mocked.documentFolders } },
    tableFolder: { tree: { useQuery: () => mocked.tableFolders } },
    useUtils: () => ({
      ingestion: {
        getFile: { invalidate: vi.fn() },
        getBatch: { invalidate: vi.fn() },
        listBatches: { invalidate: vi.fn() },
      },
      document: { list: { invalidate: vi.fn() } },
      folder: { tree: { invalidate: vi.fn() } },
      table: { list: { invalidate: vi.fn() } },
      tableFolder: { tree: { invalidate: vi.fn() } },
    }),
  },
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const readyDocument: FileDetail = {
  id: "file",
  batchId: "batch",
  projectId: "project",
  fileName: "notes.md",
  mimeType: "text/markdown",
  byteSize: 10,
  status: "ready",
  failureKind: null,
  failureMessage: null,
  parserAdapterId: "native",
  parserVersion: "1",
  attemptCount: 3,
  createdAt: new Date("2026-09-07T00:00:00Z"),
  updatedAt: new Date("2026-09-07T00:00:00Z"),
  targetKind: "document",
  acceptedResourceId: null,
  draft: {
    targetKind: "document",
    proposedTitle: "Notes",
    proposedFolderPath: "gone",
    proposedTags: [],
    markdown: "# Notes\n\nBody.\n",
    table: null,
    warnings: ["AI analysis skipped"],
    editedById: null,
    acceptedResourceId: null,
    acceptedCommitSha: null,
    revision: 0,
    links: [
      {
        documentId: "11111111-1111-4111-8111-111111111111",
        title: "Setup",
        anchor: null,
        confidence: 0.9,
        excerpt: "Setup steps",
        keep: true,
      },
    ],
  },
};
const render = () =>
  renderToStaticMarkup(<ReviewScreen projectId="project" fileId="file" />);

describe("ReviewScreen", () => {
  beforeEach(() => {
    mutations.toastError.mockClear();
    for (const query of Object.values(mocked)) {
      query.data = undefined;
      query.error = null;
      query.isLoading = false;
    }
    mocked.project.data = { myRole: "Editor" };
    mocked.file.data = readyDocument;
    mocked.documentFolders.data = { folders: ["guides"] };
  });
  it.each(["markdown", "rows", "draft", "unknown", "columns", undefined])(
    "shows non-rendered %s mutation errors visibly",
    (field) => {
      render();
      const error = {
        data: { field },
        message: "Deselect related documents and try again",
      };
      mutations.acceptError!(error);
      mutations.updateError!(error);
      expect(mutations.toastError.mock.calls).toEqual([
        [error.message],
        [error.message],
      ]);
    },
  );

  it.each(["proposedTitle", "proposedFolderPath", "columns"])(
    "keeps rendered %s errors inline",
    (field) => {
      mocked.file.data = {
        ...readyDocument,
        draft: {
          ...readyDocument.draft!,
          targetKind: "table",
          table: {
            columns: [{ name: "Name", type: "text" }],
            sampleRows: [],
            rowCount: 0,
          },
        },
      };
      mocked.tableFolders.data = { folders: [] };
      render();
      mutations.acceptError!({ data: { field }, message: "Fix this field" });
      expect(mutations.toastError).not.toHaveBeenCalled();
    },
  );

  it("renders editable document links, warnings, preview and normalized folder notice", () => {
    const html = render();
    for (const text of [
      "Review notes.md",
      "Setup steps",
      "High match",
      "AI analysis skipped",
      "no longer exists",
      "Draft preview",
      ">Accept<",
      "will be linked",
    ])
      expect(html).toContain(text);
    expect(html).toContain('type="checkbox"');
  });
  it("shows table links as navigable read-only suggestions with truthful copy", () => {
    mocked.file.data = {
      ...readyDocument,
      targetKind: "table",
      draft: {
        ...readyDocument.draft!,
        targetKind: "table",
        markdown: null,
        table: {
          columns: [{ name: "Name", type: "text" }],
          sampleRows: [["A"]],
          rowCount: 1,
        },
      },
    };
    mocked.tableFolders.data = { folders: [] };
    const html = render();
    expect(html).toContain("reference suggestions");
    expect(html).toContain("not added to the table");
    expect(html).toContain(
      "/projects/project/documents/11111111-1111-4111-8111-111111111111",
    );
    expect(html).not.toContain('type="checkbox"');
  });
  it("offers direct acceptance recovery and rejects a file from another project", () => {
    mocked.file.data = { ...readyDocument, status: "accepting" };
    expect(render()).toContain("Retry acceptance");
    mocked.file.data = { ...readyDocument, projectId: "other" };
    expect(render()).toContain("does not belong to this project");
  });
  it("renders retryable project and required-folder errors", () => {
    mocked.project.error = new Error("network");
    expect(render()).toContain("Retry loading review");
    mocked.project.error = null;
    mocked.documentFolders.error = new Error("network");
    expect(render()).toContain("Retry loading review");
    expect(render()).not.toContain("no longer exists");
  });
  it("hides review from viewers and shows the accepted link", () => {
    mocked.project.data = { myRole: "Viewer" };
    expect(render()).toContain("Editor access to this project is required");
    mocked.project.data = { myRole: "Editor" };
    mocked.file.data = {
      ...readyDocument,
      status: "accepted",
      acceptedResourceId: "doc-1",
      draft: {
        ...readyDocument.draft!,
        acceptedResourceId: "doc-1",
        acceptedCommitSha: "a".repeat(40),
      },
    };
    const html = render();
    expect(html).toContain("/projects/project/documents/doc-1");
    expect(html).toContain("disabled");
  });
  it("renders accessible title, folder and column validation feedback", () => {
    const html = renderToStaticMarkup(
      <>
        <FieldError message="Enter a title" />
        <FieldError message="Folder no longer exists" />
        <FieldError message="Name the column" />
      </>,
    );
    expect(html).toContain("Enter a title");
    expect(html).toContain("Folder no longer exists");
    expect(html).toContain("Name the column");
    expect(html).toContain('role="alert"');
  });
});
