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
  dueAt: Date;
  lastReviewedAt: Date | null;
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
    review: { listDue: { useInfiniteQuery: () => mocked.query } },
  },
}));

import { ReviewsScreen } from "./ReviewsScreen";

const item = (overrides: Partial<Item>): Item => ({
  id: "doc-1",
  title: "Runbook",
  path: "ops/runbooks/runbook.md",
  projectId: "project-1",
  projectName: "Platform",
  dueAt: new Date("2020-03-01T12:00:00Z"),
  lastReviewedAt: null,
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
    renderer = create(<ReviewsScreen />);
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

describe("ReviewsScreen", () => {
  beforeEach(() => {
    mocked.refetch.mockReset();
    mocked.fetchNextPage.mockReset();
    setQuery({});
  });

  it("renders the heading, sub-line and the column headers", () => {
    setQuery({ data: pages([item({})]) });

    const html = text(mount());

    expect(html).toContain("Open reviews");
    expect(html).toContain("Documents that are due for your review.");
    for (const header of [
      "Document",
      "Project",
      "Folder",
      "Due",
      "Last reviewed",
    ])
      expect(html).toContain(header);
  });

  it("links each document and shows project, folder, due and Never", () => {
    setQuery({ data: pages([item({})]) });

    const root = mount();
    const link = root.findByType("a");
    const cells = root.findAll((node) => node.type === "td").map(text);

    expect(link.props.href).toBe("/projects/project-1/documents/doc-1");
    expect(text(link)).toBe("Runbook");
    expect(cells[1]).toBe("Platform");
    expect(cells[2]).toBe("ops / runbooks");
    expect(cells[3]).toBe("Not reviewed yet");
    expect(cells[4]).toBe("Never");
  });

  it("shows the due date and overdue marker of a reviewed document", () => {
    setQuery({
      data: pages([item({ lastReviewedAt: new Date("2019-03-01T12:00:00Z") })]),
    });

    const cells = mount()
      .findAll((node) => node.type === "td")
      .map(text);

    expect(cells[3]).toContain("(overdue)");
    expect(cells[3]).toMatch(/2020/);
  });

  it("shows a dash for the project root and the last review date", () => {
    setQuery({
      data: pages([
        item({
          path: "plan.md",
          lastReviewedAt: new Date("2019-03-01T12:00:00Z"),
        }),
      ]),
    });

    const cells = mount()
      .findAll((node) => node.type === "td")
      .map(text);

    expect(cells[2]).toBe("—");
    expect(cells[4]).toMatch(/2019/);
  });

  it("styles the due cell of a reviewed document as overdue", () => {
    setQuery({
      data: pages([item({ lastReviewedAt: new Date("2019-03-01T12:00:00Z") })]),
    });

    const dueCell = mount().findAll((node) => node.type === "td")[3]!;

    expect(dueCell.props.className).toContain("text-danger");
  });

  it("styles the due cell of a never-reviewed document as due, not overdue", () => {
    setQuery({ data: pages([item({})]) });

    const dueCell = mount().findAll((node) => node.type === "td")[3]!;

    expect(dueCell.props.className).toContain("text-review");
    expect(dueCell.props.className).not.toContain("text-danger");
  });

  it("renders no dates before mount", () => {
    setQuery({ data: pages([item({})]) });

    const html = renderToStaticMarkup(<ReviewsScreen />);

    expect(html).toContain("Runbook");
    expect(html).not.toContain("<time");
    expect(html).not.toContain("Never");
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

    const html = renderToStaticMarkup(<ReviewsScreen />);

    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Nothing is due for review.");
  });

  it("renders the empty state", () => {
    setQuery({ data: pages([]) });

    expect(text(mount())).toContain("Nothing is due for review.");
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

    const root = mount();
    click(buttonByText(root, "Load more"));

    expect(mocked.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("disables Load more while the next page is pending", () => {
    setQuery({
      data: pages([item({})]),
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    const button = buttonByText(mount(), "Loading…")!;

    expect(button.props.disabled).toBe(true);
  });

  it("offers no Load more on the last page", () => {
    setQuery({ data: pages([item({})]) });

    expect(buttonByText(mount(), "Load more")).toBeUndefined();
  });
});
