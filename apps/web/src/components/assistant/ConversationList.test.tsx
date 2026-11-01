import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  pages: {
    data: {
      pages: [{ items: [] as unknown[], nextCursor: null as string | null }],
    },
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    isLoading: false,
  },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    assistant: { listConversations: { useInfiniteQuery: () => mocked.pages } },
    project: {
      list: { useQuery: () => ({ data: [{ id: "p", name: "Platform" }] }) },
    },
  },
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

import { ConversationList, relativeTime } from "./ConversationList";

describe("relativeTime", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  it("describes recent activity coarsely", () => {
    expect(relativeTime(new Date("2026-09-03T11:59:30Z"), now)).toBe(
      "just now",
    );
    expect(relativeTime(new Date("2026-09-03T11:15:00Z"), now)).toBe(
      "45 min ago",
    );
    expect(relativeTime(new Date("2026-09-03T08:00:00Z"), now)).toBe("4 h ago");
    expect(relativeTime(new Date("2026-08-30T12:00:00Z"), now)).toBe("4 d ago");
  });
});

describe("ConversationList", () => {
  it("renders rows with a pin chip and an active-run dot, marking the selected one", () => {
    mocked.pages.data.pages[0]!.items = [
      {
        id: "a",
        title: "Deploy questions",
        pinnedProjectId: "p",
        lastMessageAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        activeRun: { id: "r", status: "running" },
      },
      {
        id: "b",
        title: "Other",
        pinnedProjectId: null,
        lastMessageAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        activeRun: null,
      },
    ];
    const html = renderToStaticMarkup(
      <ConversationList activeId="a" onSelect={() => undefined} />,
    );
    expect(html).toContain("Deploy questions");
    expect(html).toContain("Platform");
    expect(html).toMatch(/aria-current="true"[^>]*>[\s\S]*Deploy questions/);
    expect(html).toContain('aria-label="Run in progress"');
  });
  it("marks a conversation whose last run failed with a danger dot, but not a completed one", () => {
    mocked.pages.data.pages[0]!.items = [
      {
        id: "a",
        title: "Failed run",
        pinnedProjectId: null,
        lastMessageAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        activeRun: null,
        lastRunStatus: "failed",
      },
      {
        id: "b",
        title: "Completed run",
        pinnedProjectId: null,
        lastMessageAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        activeRun: null,
        lastRunStatus: "completed",
      },
    ];
    const html = renderToStaticMarkup(
      <ConversationList activeId={null} onSelect={() => undefined} />,
    );
    expect(html).toContain('aria-label="Last run failed"');
    expect(html).toContain("bg-danger");
    expect((html.match(/aria-label="Last run failed"/g) ?? []).length).toBe(1);
  });

  it("shows the empty state", () => {
    mocked.pages.data.pages[0]!.items = [];
    expect(
      renderToStaticMarkup(
        <ConversationList activeId={null} onSelect={() => undefined} />,
      ),
    ).toContain("No conversations yet");
  });
});
