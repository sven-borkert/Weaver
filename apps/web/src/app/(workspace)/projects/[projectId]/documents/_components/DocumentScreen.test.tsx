import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryState = {
  data: unknown;
  error: { data?: { code?: string } } | undefined;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

const query = (): QueryState => ({
  data: undefined,
  error: undefined,
  isLoading: false,
  refetch: () => Promise.resolve(),
});

const mocked = vi.hoisted(
  (): Record<"projectQuery" | "documentQuery", QueryState> => {
    const initial = (): QueryState => ({
      data: undefined,
      error: undefined,
      isLoading: false,
      refetch: () => Promise.resolve(),
    });
    return {
      projectQuery: initial(),
      documentQuery: initial(),
    };
  },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    project: { get: { useQuery: () => mocked.projectQuery } },
    document: { get: { useQuery: () => mocked.documentQuery } },
    scheduledTask: {
      byOutputDocument: { useQuery: () => ({ data: null }) },
    },
  },
}));

vi.mock("./DocumentEditor", () => ({ DocumentEditor: vi.fn(() => null) }));
vi.mock("./DocumentViewer", () => ({ DocumentViewer: vi.fn(() => null) }));
vi.mock("./DocumentDiff", () => ({ DocumentDiff: () => null }));
vi.mock("./DocumentsWorkspace", () => ({
  DocumentsWorkspace: ({
    children,
    contextRail,
  }: {
    children: React.ReactNode;
    contextRail: React.ReactNode;
  }) => (
    <>
      {contextRail}
      {children}
    </>
  ),
}));
vi.mock("./ContextRail", () => ({ ContextRail: vi.fn(() => null) }));
vi.mock("./DocumentOutlinePanel", () => ({ DocumentOutlinePanel: () => null }));
vi.mock("./DocumentHistoryPanel", () => ({ DocumentHistoryPanel: () => null }));
vi.mock("./DocumentLinksPanel", () => ({ DocumentLinksPanel: () => null }));
vi.mock("./DocumentIndexPanel", () => ({ DocumentIndexPanel: () => null }));

import type { ReactElement } from "react";
import { DocumentScreen } from "./DocumentScreen";
import { ContextRail } from "./ContextRail";
import { DocumentEditor } from "./DocumentEditor";
import { DocumentViewer } from "./DocumentViewer";

const render = () =>
  renderToStaticMarkup(
    <DocumentScreen projectId="project-1" documentId="document-1" />,
  );

const transientError = { data: { code: "INTERNAL_SERVER_ERROR" } };

describe("DocumentScreen error states", () => {
  beforeEach(() => {
    Object.assign(mocked.projectQuery, query());
    Object.assign(mocked.documentQuery, query());
    vi.clearAllMocks();
  });

  it("offers a retry when the project fails to load", () => {
    mocked.projectQuery.error = transientError;

    const html = render();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load project");
    expect(html).toContain("Retry");
  });

  it("does not offer a retry for a missing project", () => {
    mocked.projectQuery.error = { data: { code: "NOT_FOUND" } };

    const html = render();

    expect(html).toContain("Project not found");
    expect(html).not.toContain("Retry");
  });

  it("offers a retry when the document fails to load", () => {
    mocked.projectQuery.data = { id: "project-1", myRole: "Editor" };
    mocked.documentQuery.error = transientError;

    const html = render();

    expect(html).toContain("Could not load document");
    expect(html).toContain("Retry");
  });

  it("does not offer a retry for a missing document", () => {
    mocked.projectQuery.data = { id: "project-1", myRole: "Editor" };
    mocked.documentQuery.error = { data: { code: "NOT_FOUND" } };

    const html = render();

    expect(html).toContain("Document not found");
    expect(html).not.toContain("Retry");
  });

  it("opens the editing surface directly for an Editor", () => {
    mocked.projectQuery.data = { id: "project-1", myRole: "Editor" };
    mocked.documentQuery.data = {
      id: "document-1",
      title: "Overview",
      baseCommitSha: "a".repeat(40),
      content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
    };
    render();
    expect(DocumentEditor).toHaveBeenCalled();
    expect(vi.mocked(DocumentEditor).mock.calls[0]?.[0]).toMatchObject({
      canEdit: true,
    });
    expect(DocumentViewer).not.toHaveBeenCalled();
  });

  it("opens a ?version= deep link as a comparison, except for the current version", () => {
    mocked.projectQuery.data = { id: "project-1", myRole: "Editor" };
    mocked.documentQuery.data = {
      id: "document-1",
      title: "Overview",
      baseCommitSha: "a".repeat(40),
      content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
    };
    const open = (initialVersionSha: string) =>
      renderToStaticMarkup(
        <DocumentScreen
          projectId="project-1"
          documentId="document-1"
          initialVersionSha={initialVersionSha}
        />,
      );

    expect(open("b".repeat(40))).toContain('data-document-mode="diff"');
    expect(DocumentEditor).not.toHaveBeenCalled();

    expect(open("a".repeat(40))).toContain('data-document-mode="document"');
    expect(DocumentEditor).toHaveBeenCalled();
  });

  it("retains the read-only viewer for project Viewers", () => {
    mocked.projectQuery.data = { id: "project-1", myRole: "Viewer" };
    mocked.documentQuery.data = {
      id: "document-1",
      title: "Overview",
      baseCommitSha: "a".repeat(40),
      content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
    };
    render();
    expect(DocumentViewer).toHaveBeenCalled();
    expect(DocumentEditor).not.toHaveBeenCalled();
  });
});

it("keeps a dirty draft visible but locks it after access is revoked", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: vi.fn(),
  });
  Object.assign(mocked.projectQuery, query(), {
    data: { id: "project-1", myRole: "Editor" },
  });
  Object.assign(mocked.documentQuery, query(), {
    data: {
      id: "document-1",
      title: "Overview",
      baseCommitSha: "a".repeat(40),
      content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
    },
  });
  vi.clearAllMocks();
  let renderer: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DocumentScreen projectId="project-1" documentId="document-1" />,
      );
    });
    const editor = vi.mocked(DocumentEditor).mock.calls.at(-1)![0];
    await act(async () => {
      editor.onDirtyChange(true);
    });
    mocked.projectQuery.error = { data: { code: "NOT_FOUND" } };
    await act(async () => {
      renderer.update(
        <DocumentScreen projectId="project-1" documentId="document-1" />,
      );
    });
    expect(vi.mocked(DocumentEditor).mock.calls.at(-1)![0].canEdit).toBe(false);
    expect(DocumentViewer).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    vi.unstubAllGlobals();
  }
});

it("stays in the editor after a save when the deep-linked version was the current one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: vi.fn(),
  });
  const documentData = (baseCommitSha: string) => ({
    id: "document-1",
    title: "Overview",
    baseCommitSha,
    content: { kind: "markdown", contentJson: { type: "doc", content: [] } },
  });
  Object.assign(mocked.projectQuery, query(), {
    data: { id: "project-1", myRole: "Editor" },
  });
  Object.assign(mocked.documentQuery, query(), {
    data: documentData("a".repeat(40)),
  });
  vi.clearAllMocks();
  // A fresh element per render, or React bails out of the update.
  const screen = () => (
    <DocumentScreen
      projectId="project-1"
      documentId="document-1"
      initialVersionSha={"a".repeat(40)}
    />
  );
  let renderer: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(screen());
    });
    expect(DocumentEditor).toHaveBeenCalled();
    // The save advanced the base; the stale diff state must not resurface.
    mocked.documentQuery.data = documentData("c".repeat(40));
    await act(async () => {
      renderer.update(screen());
    });
    expect(
      renderer!.root.findByProps({ "data-document-mode": "document" }),
    ).toBeDefined();
    expect(
      renderer!.root.findAllByProps({ "data-document-mode": "diff" }),
    ).toHaveLength(0);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    vi.unstubAllGlobals();
  }
});

describe("DocumentScreen contents", () => {
  const sha = "a".repeat(40);
  beforeEach(() => {
    Object.assign(mocked.projectQuery, query(), {
      data: { id: "project-1", myRole: "Viewer" },
    });
    Object.assign(mocked.documentQuery, query(), {
      data: {
        id: "document-1",
        title: "Overview",
        baseCommitSha: sha,
        content: {
          kind: "markdown",
          contentJson: { type: "doc", content: [] },
        },
      },
    });
    vi.clearAllMocks();
  });

  it("opens the Contents tab unless a version deep link asks for History", () => {
    render();
    expect(vi.mocked(ContextRail).mock.calls.at(-1)![0].activeTab).toBe(
      "contents",
    );
    renderToStaticMarkup(
      <DocumentScreen
        projectId="project-1"
        documentId="document-1"
        initialVersionSha={"b".repeat(40)}
      />,
    );
    expect(vi.mocked(ContextRail).mock.calls.at(-1)![0].activeTab).toBe(
      "history",
    );
  });

  it("jumps to a chosen section again on every choice until the link changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: vi.fn(),
    });
    const linked = { section: "section-intro", sourceCommitSha: sha };
    const screen = (sectionNavigation = linked) => (
      <DocumentScreen
        projectId="project-1"
        documentId="document-1"
        sectionNavigation={sectionNavigation}
      />
    );
    const choose = async (anchor: string) => {
      const contents = vi.mocked(ContextRail).mock.calls.at(-1)![0]
        .contents as ReactElement<{ onSelect: (anchor: string) => void }>;
      await act(async () => {
        contents.props.onSelect(anchor);
      });
    };
    const viewerNavigation = () =>
      vi.mocked(DocumentViewer).mock.calls.at(-1)![0].sectionNavigation;
    let renderer: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(screen());
      });
      expect(viewerNavigation()).toEqual(linked);
      await choose("section-usage");
      expect(viewerNavigation()).toEqual({
        section: "section-usage",
        sourceCommitSha: sha,
        jump: 1,
      });
      await choose("section-usage");
      expect(viewerNavigation()).toMatchObject({ jump: 2 });
      const next = { section: "section-other", sourceCommitSha: sha };
      await act(async () => {
        renderer.update(screen(next));
      });
      expect(viewerNavigation()).toEqual(next);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});
