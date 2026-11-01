import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";

type SummaryList = RouterOutputs["diagnostics"]["listChangeSummaries"];

const row = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectName: "Alpha",
  documentId: "11111111-1111-4111-8111-111111111111",
  commitSha: "43ba80197f78908371b904501bea820d0ac17bd9",
  baseCommitSha: "412d718a3aefc706a94c0025b56c715c3f20bdb3",
  status: "failed" as const,
  failureReason: "timeout",
  attempts: 3,
  lastErrorClass: "AiProviderError",
  lastJobId: "aaf2c29d-39bd-458b-9448-c838b58556c8",
  createdAt: new Date("2026-09-16T17:33:52.000Z"),
  updatedAt: new Date("2026-09-16T17:36:00.000Z"),
  completedAt: new Date("2026-09-16T17:36:00.000Z"),
};

const mocked = vi.hoisted(() => ({
  calls: [] as unknown[],
  query: {
    data: undefined as SummaryList | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

vi.mock("~/components/ui/select", () => ({
  Select: ({ children, value }: { children: ReactNode; value?: string }) => (
    <div data-slot="select-test" data-value={value}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <span data-value={value}>{children}</span>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => <span />,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    diagnostics: {
      listChangeSummaries: {
        useQuery: (input: unknown) => {
          mocked.calls.push(input);
          return mocked.query;
        },
      },
    },
  },
}));

import { ChangeSummariesCard } from "./ChangeSummariesCard";

describe("ChangeSummariesCard", () => {
  beforeEach(() => {
    mocked.calls = [];
    mocked.query.error = undefined;
    mocked.query.isLoading = false;
    mocked.query.data = {
      items: [row],
      nextCursor: null,
      truncated: false,
      counts: { pending: 2, ready: 5, failed: 1, skipped: 0 },
      projects: [{ id: row.projectId, name: "Alpha" }],
    };
  });

  it("renders counts, row details, and a link to the matching events", () => {
    const markup = renderToStaticMarkup(<ChangeSummariesCard />);
    expect(mocked.calls[0]).toEqual({ limit: 25 });
    expect(markup).toContain("Change summaries");
    expect(markup).toContain("pending · 2");
    expect(markup).toContain("failed · 1");
    expect(markup).toContain("Alpha");
    expect(markup).toContain("43ba8019");
    expect(markup).toContain("timeout");
    expect(markup).toContain("AiProviderError");
    expect(markup).toContain("2 min");
    expect(markup).toContain(
      'href="/admin/diagnostics?documentId=11111111-1111-4111-8111-111111111111&amp;jobId=aaf2c29d-39bd-458b-9448-c838b58556c8#events"',
    );
  });

  it("shows empty and error states", () => {
    mocked.query.data = {
      items: [],
      nextCursor: null,
      truncated: false,
      counts: { pending: 0, ready: 0, failed: 0, skipped: 0 },
      projects: [],
    };
    expect(renderToStaticMarkup(<ChangeSummariesCard />)).toContain(
      "No change summaries match these filters.",
    );
    mocked.query.data = undefined;
    mocked.query.error = new Error("boom");
    expect(renderToStaticMarkup(<ChangeSummariesCard />)).toContain(
      "Could not load change summaries.",
    );
  });
});
