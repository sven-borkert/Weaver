import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = {
  id: string;
  title: string;
  path: string;
  projectId: string;
  projectName: string;
  lastReviewedAt: Date;
  reviewedBy: { id: string | null; name: string } | null;
  dueAt: Date | null;
};

const mocked = vi.hoisted(() => {
  const query: Record<string, unknown> = {};
  return { query, refetch: vi.fn(), fetchNextPage: vi.fn() };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    review: { listRecent: { useInfiniteQuery: () => mocked.query } },
  },
}));

import { RecentlyReviewedScreen } from "./RecentlyReviewedScreen";

const item = (overrides: Partial<Item>): Item => ({
  id: "doc-1",
  title: "Runbook",
  path: "ops/runbook.md",
  projectId: "project-1",
  projectName: "Platform",
  lastReviewedAt: new Date("2024-03-01T12:00:00Z"),
  reviewedBy: { id: "user-1", name: "Ada Lovelace" },
  dueAt: new Date("2025-03-01T12:00:00Z"),
  ...overrides,
});

function setQuery(state: Record<string, unknown>) {
  for (const key of Object.keys(mocked.query)) delete mocked.query[key];
  Object.assign(mocked.query, {
    data: undefined,
    error: null,
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: mocked.refetch,
    fetchNextPage: mocked.fetchNextPage,
    ...state,
  });
}

const pages = (...items: Item[][]) => ({
  pages: items.map((page) => ({ items: page, nextCursor: null })),
});

function mount() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<RecentlyReviewedScreen />);
  });
  return renderer.root;
}

const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");

const click = (button: ReactTestInstance | undefined) => {
  act(() => {
    (button!.props as { onClick: () => void }).onClick();
  });
};

const buttonByText = (root: ReactTestInstance, label: string) =>
  root.findAll(
    (node) => node.type === "button" && text(node).trim() === label,
  )[0];

describe("RecentlyReviewedScreen", () => {
  beforeEach(() => {
    mocked.refetch.mockReset();
    mocked.fetchNextPage.mockReset();
    setQuery({});
  });

  it("renders the heading and the column headers", () => {
    setQuery({ data: pages([item({})]) });

    const html = text(mount());

    expect(html).toContain("Recently reviewed");
    for (const header of [
      "Document",
      "Project",
      "Reviewed by",
      "Reviewed",
      "Next review due",
    ])
      expect(html).toContain(header);
  });

  it("links each document and shows project, reviewer and dates", () => {
    setQuery({ data: pages([item({})]) });

    const root = mount();
    const link = root.findByType("a");
    const cells = root.findAll((node) => node.type === "td").map(text);

    expect(link.props.href).toBe("/projects/project-1/documents/doc-1");
    expect(text(link)).toBe("Runbook");
    expect(cells[1]).toBe("Platform");
    expect(cells[2]).toBe("Ada Lovelace");
    expect(cells[3]).toMatch(/2024/);
    expect(cells[4]).toMatch(/2025/);
  });

  it("shows a dash when the reviewer is unknown", () => {
    setQuery({ data: pages([item({ reviewedBy: null })]) });

    const cells = mount()
      .findAll((node) => node.type === "td")
      .map(text);

    expect(cells[2]).toBe("—");
  });

  it("renders no dates before mount", () => {
    setQuery({ data: pages([item({})]) });

    const html = renderToStaticMarkup(<RecentlyReviewedScreen />);

    expect(html).toContain("Runbook");
    expect(html).not.toContain("<time");
  });

  it("flattens all loaded pages", () => {
    setQuery({
      data: pages(
        [item({ id: "a", title: "First" })],
        [item({ id: "b", title: "Second" })],
      ),
    });

    const html = text(mount());

    expect(html).toContain("First");
    expect(html).toContain("Second");
  });

  it("renders skeletons while loading", () => {
    setQuery({ isLoading: true });

    const html = renderToStaticMarkup(<RecentlyReviewedScreen />);

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("No document has been reviewed yet.");
  });

  it("renders the empty state", () => {
    setQuery({ data: pages([]) });

    expect(text(mount())).toContain("No document has been reviewed yet.");
  });

  it("renders an error with a working retry", () => {
    setQuery({ error: { data: { code: "INTERNAL_SERVER_ERROR" } } });

    const root = mount();

    expect(text(root)).toContain("Could not load reviews.");
    click(buttonByText(root, "Retry"));
    expect(mocked.refetch).toHaveBeenCalledTimes(1);
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "does not show cached rows after a %s error",
    (code) => {
      setQuery({
        data: pages([item({})]),
        error: { data: { code } },
      });

      const html = text(mount());

      expect(html).not.toContain("Runbook");
      expect(html).toContain("Could not load reviews.");
    },
  );

  it("loads more while another page exists", () => {
    setQuery({ data: pages([item({})]), hasNextPage: true });

    click(buttonByText(mount(), "Load more"));

    expect(mocked.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("disables Load more while the next page is pending", () => {
    setQuery({
      data: pages([item({})]),
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    expect(buttonByText(mount(), "Loading…")!.props.disabled).toBe(true);
  });

  it("offers no Load more on the last page", () => {
    setQuery({ data: pages([item({})]) });

    expect(buttonByText(mount(), "Load more")).toBeUndefined();
  });
});
