import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";

type Page = RouterOutputs["diagnostics"]["listProcessing"];
const mock = vi.hoisted(() => ({
  calls: [] as Array<{
    input: unknown;
    options: { refetchInterval: number | false };
  }>,
  query: {
    data: undefined as Page | undefined,
    error: null as Error | null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  },
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
  SelectValue: () => <span />,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    diagnostics: {
      listProcessing: {
        useQuery: (
          input: unknown,
          options: { refetchInterval: number | false },
        ) => {
          mock.calls.push({ input, options });
          return mock.query;
        },
      },
      listProcessingQueue: {
        useQuery: () => ({
          data: undefined,
          error: null,
          isLoading: false,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      processingQueueSummary: {
        useQuery: () => ({ data: undefined, error: null, refetch: vi.fn() }),
      },
      getRetentionSettings: {
        useQuery: () => ({
          data: {
            settings: {
              ingestionDays: 30,
              assistantConversationDays: 90,
              taskRunDays: 30,
              aiUsageDays: 90,
            },
          },
          error: null,
          isLoading: false,
        }),
      },
    },
  },
}));

import { ProcessingCard, processingEventsHref } from "./ProcessingCard";
const id = "11111111-1111-4111-8111-111111111111";
describe("processing diagnostics", () => {
  beforeEach(() => {
    mock.calls = [];
    mock.query.error = null;
    mock.query.data = {
      counts: [{ status: "failed", count: "1" }],
      nextCursor: "next",
      items: [
        {
          id: `${id}:${id}`,
          projectId: id,
          documentId: id,
          generationId: id,
          jobId: id,
          runId: null,
          fileId: null,
          status: "failed",
          attempts: 3,
          failureCode: "validation",
          createdAt: new Date("2026-09-01T12:00:00Z"),
          lastAttemptAt: null,
          completedAt: null,
        },
      ],
    };
  });
  it("shows durable status and links all document attempts without pinning one delivery", () => {
    const html = renderToStaticMarkup(<ProcessingCard />);
    expect(html).toContain("validation");
    expect(html).toContain("failed");
    expect(html).toContain("generationId=");
    expect(html).not.toContain("jobId=");
    expect(processingEventsHref(mock.query.data!.items[0]!, true)).toBe(
      `/admin/diagnostics?jobId=${id}#events`,
    );
  });
  it("links successful task output to the run lifecycle without unrelated correlations", () => {
    expect(
      processingEventsHref({
        projectId: id,
        runId: id,
        documentId: id,
        generationId: id,
        jobId: id,
      }),
    ).toBe(`/admin/diagnostics?runId=${id}#events`);
  });
  it("links all ingestion stages by file while queue links keep one delivery", () => {
    const row = {
      projectId: id,
      fileId: id,
      runId: null,
      documentId: id,
      generationId: id,
      jobId: id,
    };
    expect(processingEventsHref(row)).toBe(
      `/admin/diagnostics?fileId=${id}#events`,
    );
    expect(processingEventsHref(row, true)).toBe(
      `/admin/diagnostics?jobId=${id}#events`,
    );
  });
  it("hides cached work after a query error", () => {
    mock.query.error = new Error("FORBIDDEN");
    const html = renderToStaticMarkup(<ProcessingCard />);
    expect(html).toContain("Processing state unavailable");
    expect(html).not.toContain("validation");
    expect(html).not.toContain("generationId=");
  });
  it("polls only the current first page", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<ProcessingCard />);
    });
    expect(mock.calls.at(-1)?.options.refetchInterval).toBe(15000);
    const next = renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Next"))!;
    act(() => {
      (next.props as { onClick: () => void }).onClick();
    });
    expect(mock.calls.at(-1)?.input).toMatchObject({ cursor: "next" });
    expect(mock.calls.at(-1)?.options.refetchInterval).toBe(false);
    act(() => renderer.unmount());
  });
});
