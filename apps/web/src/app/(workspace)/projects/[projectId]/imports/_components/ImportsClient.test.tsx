import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BatchDetail,
  BatchSummary,
} from "@weaver/core/services/ingestion";
import { ImportsClient } from "./ImportsClient";
import ImportsPage from "../page";
import { BatchTable } from "./BatchTable";
import { ingestionPollingInterval } from "./imports-state";

type Query = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  refetch: () => Promise<void>;
};
const mocked = vi.hoisted(() => {
  const query = (): Query => ({
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: () => Promise.resolve(),
  });
  return {
    project: query(),
    list: query(),
    detail: query(),
    listEnabled: false,
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    project: { get: { useQuery: () => mocked.project } },
    ingestion: {
      listBatches: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          mocked.listEnabled = options.enabled;
          return mocked.list;
        },
      },
      getBatch: { useQuery: () => mocked.detail },
      retry: {
        useMutation: () => ({
          isPending: false,
          error: null,
          mutate: () => undefined,
        }),
      },
      deleteBatch: {
        useMutation: () => ({
          isPending: false,
          error: null,
          mutate: () => undefined,
        }),
      },
    },
    useUtils: () => ({
      ingestion: {
        listBatches: { invalidate: () => Promise.resolve() },
        getBatch: { invalidate: () => Promise.resolve() },
      },
    }),
  },
}));
vi.mock("~/env", () => ({ env: { WEAVER_INGESTION_MAX_FILE_BYTES: 2048 } }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

const batch: BatchSummary = {
  id: "batch",
  label: "Private upload",
  origin: "upload",
  createdAt: new Date("2026-09-05T12:00:00Z"),
  createdById: "user",
  createdBy: {
    id: "user",
    name: "Editor Person",
    email: "editor@example.test",
  },
  fileCount: 2,
  status: "attention",
  hasActiveFiles: true,
};
const detail: BatchDetail = {
  ...batch,
  files: [
    {
      id: "failed",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 1024,
      status: "failed",
      failureKind: "parser",
      failureMessage: "PDF parsing is not available yet",
      parserAdapterId: null,
      parserVersion: null,
      attemptCount: 1,
      createdAt: batch.createdAt,
      updatedAt: batch.createdAt,
      targetKind: null,
      acceptedResourceId: null,
    },
    {
      id: "pending",
      fileName: "notes.md",
      mimeType: "text/markdown",
      byteSize: 10,
      status: "pending",
      failureKind: null,
      failureMessage: null,
      parserAdapterId: null,
      parserVersion: null,
      attemptCount: 0,
      createdAt: batch.createdAt,
      updatedAt: batch.createdAt,
      targetKind: null,
      acceptedResourceId: null,
    },
  ],
};
const render = () =>
  renderToStaticMarkup(<ImportsClient projectId="project" maxBytes={1024} />);

describe("Imports access and loading", () => {
  beforeEach(() => {
    for (const query of [mocked.project, mocked.list, mocked.detail]) {
      query.data = undefined;
      query.error = null;
      query.isLoading = false;
    }
    mocked.project.data = { myRole: "Editor" };
    mocked.list.data = { items: [batch], nextCursor: "next" };
  });
  it("shows Editor uploads, batches, creator and next-page navigation", () => {
    const html = render();
    expect(html).toContain("Choose files");
    expect(html).toContain("Private upload");
    expect(html).toContain("Editor Person");
    expect(html).toContain("Next");
  });
  it("passes the awaited project and configured upload cap through the route", async () => {
    const page = await ImportsPage({
      params: Promise.resolve({ projectId: "project" }),
    });
    expect(page.props).toMatchObject({ projectId: "project" });
    expect(renderToStaticMarkup(page)).toContain("2.0 KB");
  });
  it("waits for project access before exposing cached batches", () => {
    mocked.project.data = undefined;
    mocked.project.isLoading = true;
    expect(render()).not.toContain("Private upload");
    expect(render()).not.toContain("Choose files");
    expect(mocked.listEnabled).toBe(false);
  });
  it("disables pagination at the first page and when there is no next cursor", () => {
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    expect(render()).not.toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
    mocked.list.data = { items: [batch], nextCursor: null };
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
  });
  it("hides cached batches and uploading from Viewers", () => {
    mocked.project.data = { myRole: "Viewer" };
    const html = render();
    expect(html).not.toContain("Private upload");
    expect(html).not.toContain("Choose files");
    expect(mocked.listEnabled).toBe(false);
  });
  it.each(["project", "list", "detail"] as const)(
    "hides every control on cached %s authorization failure",
    (query) => {
      mocked.detail.data = detail;
      mocked[query].error = { data: { code: "FORBIDDEN" } };
      const html = render();
      expect(html).toContain("Imports unavailable");
      expect(html).not.toContain("Private upload");
      expect(html).not.toContain("Choose files");
      expect(html).not.toContain("Delete");
    },
  );
  it.each(["UNAUTHORIZED", "NOT_FOUND"])("hides stale data for %s", (code) => {
    mocked.list.error = { data: { code } };
    expect(render()).not.toContain("Private upload");
  });
  it("distinguishes loading, initial errors, refresh errors and empty results", () => {
    mocked.list.data = undefined;
    mocked.list.isLoading = true;
    expect(render()).toContain("Loading imports");
    mocked.list.isLoading = false;
    mocked.list.error = new Error("network");
    expect(render()).toContain("Could not load imports");
    mocked.list.data = { items: [batch], nextCursor: null };
    expect(render()).toContain("could not refresh");
    expect(render()).toContain("Private upload");
    mocked.list.error = null;
    mocked.list.data = { items: [], nextCursor: null };
    expect(render()).toContain("No imports yet");
  });
});

describe("batch presentation and polling", () => {
  it("keeps mixed attention batches polling and stops after all files settle", () => {
    expect(ingestionPollingInterval([batch])).toBe(2000);
    expect(
      ingestionPollingInterval([{ ...batch, hasActiveFiles: false }]),
    ).toBe(false);
    expect(ingestionPollingInterval([detail])).toBe(2000);
    expect(ingestionPollingInterval(undefined)).toBe(false);
  });
  it("shows stable batch columns, expanded failures, sizes and retry actions", () => {
    const html = renderToStaticMarkup(
      <BatchTable
        projectId="project"
        batches={[batch]}
        expandedId="batch"
        detail={detail}
        detailLoading={false}
        detailError={false}
        busy={false}
        onExpand={() => undefined}
        onDelete={() => undefined}
        onRetry={() => undefined}
        onRefreshDetail={() => undefined}
      />,
    );
    for (const label of [
      "Label",
      "Origin",
      "Files",
      "Status",
      "Created by",
      "Created",
      "Actions",
      "Upload",
      "Needs attention",
      "report.pdf",
      "1.0 KB",
      "Parser",
      "PDF parsing is not available yet",
      "Retry",
      "Queued",
    ])
      expect(html).toContain(label);
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/aria-label="Retry /g)).toHaveLength(1);
    expect(html).not.toContain("Accept draft");
  });
  it("links ready and accepting files to review and accepted files to their resource", () => {
    const files = [
      {
        ...detail.files[1]!,
        id: "ready",
        fileName: "ready.md",
        status: "ready" as const,
        targetKind: "document" as const,
      },
      {
        ...detail.files[1]!,
        id: "accepting",
        fileName: "accepting.md",
        status: "accepting" as const,
        targetKind: "document" as const,
      },
      {
        ...detail.files[1]!,
        id: "accepted",
        fileName: "accepted.md",
        status: "accepted" as const,
        targetKind: "document" as const,
        acceptedResourceId: "doc",
      },
    ];
    const html = renderToStaticMarkup(
      <BatchTable
        projectId="project"
        batches={[batch]}
        expandedId="batch"
        detail={{ ...detail, files }}
        detailLoading={false}
        detailError={false}
        busy={false}
        onExpand={() => undefined}
        onDelete={() => undefined}
        onRetry={() => undefined}
        onRefreshDetail={() => undefined}
      />,
    );
    expect(html).toContain("/projects/project/imports/ready");
    expect(html).toContain("/projects/project/imports/accepting");
    expect(html).toContain("/projects/project/documents/doc");
  });
});
