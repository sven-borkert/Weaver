import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = [
  {
    id: "a3f9c2e1-1111-4111-8111-111111111111",
    createdAt: new Date("2026-09-11T17:25:06.897Z"),
    runtime: "worker" as const,
    severity: "error" as const,
    verbose: false,
    category: "ai",
    event: "ai.request",
    message:
      "POST /v1/chat/completions failed: transport_error (OUTBOUND_NOT_ALLOWED)",
    requestId: null,
    jobId: null,
    runId: "fe9d8418-03a9-4fbc-a3e0-c553700cc080",
    userId: null,
    credentialId: null,
    projectId: null,
    generationId: null,
    documentId: null,
    connectionId: null,
    durationMs: 7,
    statusCode: null,
    outcome: "error",
    details: {
      error: { name: "OutboundPolicyError", code: "OUTBOUND_NOT_ALLOWED" },
    },
    hasRequestBody: false,
    hasResponseBody: false,
  },
];

const mocked = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  listQuery: {
    data: undefined as
      | {
          items: typeof rows;
          nextCursor: string | null;
          truncated: boolean;
        }
      | undefined,
    error: undefined,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  },
  detailQuery: {
    data: undefined as { event: (typeof rows)[number]; body: null } | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    refetch: vi.fn(),
  },
  listCalls: [] as unknown[],
  detailCalls: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocked.search),
  usePathname: () => "/admin/diagnostics",
  useRouter: () => ({ replace: mocked.replace }),
}));

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

// Radix portals outside the renderer tree; render the dialog inline instead.
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div data-slot="dialog-test">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));

vi.mock("~/trpc/react", () => ({
  api: {
    diagnostics: {
      listEvents: {
        useQuery: (input: unknown) => {
          mocked.listCalls.push(input);
          return mocked.listQuery;
        },
      },
      getEvent: {
        useQuery: (input: unknown) => {
          mocked.detailCalls.push(input);
          return mocked.detailQuery;
        },
      },
    },
  },
}));

import { EventsPanel } from "./EventsPanel";
import { Select } from "~/components/ui/select";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Node = {
  type?: unknown;
  props?: Record<string, unknown>;
  children?: Node[] | null;
};

function walk(node: Node | null, visit: (node: Node) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findByLabel(tree: Node | null, label: string): Node | undefined {
  let found: Node | undefined;
  walk(tree, (node) => {
    if (!found && node.props?.["aria-label"] === label) found = node;
  });
  return found;
}

function findByText(tree: Node | null, text: string): boolean {
  return JSON.stringify(tree).includes(text);
}

function clickButton(renderer: ReactTestRenderer, label: string): void {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes(label));
  expect(button).toBeDefined();
  act(() => {
    (button!.props as { onClick: () => void }).onClick();
  });
}

function selectSeverity(renderer: ReactTestRenderer, value: string): void {
  act(() => {
    (
      renderer.root.findByType(Select).props as {
        onValueChange: (value: string) => void;
      }
    ).onValueChange(value);
  });
}

describe("EventsPanel", () => {
  beforeEach(() => {
    mocked.search = "";
    mocked.replace.mockClear();
    mocked.listCalls = [];
    mocked.detailCalls = [];
    mocked.listQuery.data = {
      items: rows,
      nextCursor: null,
      truncated: false,
    };
    mocked.listQuery.error = undefined;
    mocked.listQuery.isLoading = false;
    mocked.listQuery.isFetching = false;
    mocked.listQuery.isPlaceholderData = false;
    mocked.detailQuery.data = undefined;
    mocked.detailQuery.error = undefined;
    mocked.detailQuery.isLoading = false;
  });

  it("renders a row per event with severity, event, message, and duration", () => {
    const markup = renderToStaticMarkup(<EventsPanel />);
    expect(markup).toContain("ai.request");
    expect(markup).toContain("OUTBOUND_NOT_ALLOWED");
    expect(markup).toContain("7 ms");
    expect(markup).toContain("error");
  });

  it("shows Info and above by default with explicit severity choices", () => {
    const markup = renderToStaticMarkup(<EventsPanel />);
    expect(mocked.listCalls[0]).toEqual({ limit: 50, excludeDebug: true });
    expect(markup).toContain('data-value="info-and-above"');
    for (const label of [
      "Info and above",
      "All severities",
      "Debug",
      "Info",
      "Warning",
      "Error",
    ]) {
      expect(markup).toContain(`>${label}<`);
    }
  });

  it.each([
    { selection: "debug", expected: { limit: 50, severity: "debug" } },
    { selection: "all", expected: { limit: 50 } },
  ])(
    "applies $selection without the default debug exclusion",
    ({ selection, expected }) => {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(<EventsPanel />);
      });
      selectSeverity(renderer, selection);
      expect(mocked.listCalls.at(-1)).toEqual({
        limit: 50,
        excludeDebug: true,
      });
      clickButton(renderer, "Apply");
      expect(mocked.listCalls.at(-1)).toEqual(expected);
      act(() => renderer.unmount());
    },
  );

  it("resets pagination on Apply and restores the default filters on Clear", () => {
    mocked.search = "ref=a3f9c2e1";
    mocked.listQuery.data = { items: rows, nextCursor: "c1", truncated: true };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    clickButton(renderer, "Next");
    expect(mocked.listCalls.at(-1)).toEqual({
      limit: 50,
      excludeDebug: true,
      reference: "a3f9c2e1",
      cursor: "c1",
    });
    selectSeverity(renderer, "debug");
    clickButton(renderer, "Apply");
    expect(mocked.listCalls.at(-1)).toEqual({
      limit: 50,
      severity: "debug",
      reference: "a3f9c2e1",
    });
    clickButton(renderer, "Next");
    expect(mocked.listCalls.at(-1)).toEqual({
      limit: 50,
      severity: "debug",
      reference: "a3f9c2e1",
      cursor: "c1",
    });
    clickButton(renderer, "Clear");
    expect(mocked.listCalls.at(-1)).toEqual({ limit: 50, excludeDebug: true });
    expect(renderer.root.findByType(Select).props.value).toBe("info-and-above");
    expect(renderer.root.findByProps({ id: "events-lookup" }).props.value).toBe(
      "",
    );
    const previous = renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Previous"));
    expect(previous?.props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it("opens the detail dialog for a clicked row and shows the details JSON", () => {
    mocked.detailQuery.data = { event: rows[0]!, body: null };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    const button = findByLabel(
      renderer.toJSON() as Node | null,
      "Open event a3f9c2e1",
    );
    expect(button).toBeDefined();
    act(() => {
      (button!.props!.onClick as () => void)();
    });
    const tree = renderer.toJSON() as Node | null;
    expect(findByText(tree, '\\"code\\": \\"OUTBOUND_NOT_ALLOWED\\"')).toBe(
      true,
    );
    expect(findByText(tree, "fe9d8418-03a9-4fbc-a3e0-c553700cc080")).toBe(true);
    act(() => renderer.unmount());
  });

  it("shows a failed detail request instead of an endless skeleton", () => {
    mocked.detailQuery.error = new Error("FORBIDDEN");
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    const button = findByLabel(
      renderer.toJSON() as Node | null,
      "Open event a3f9c2e1",
    );
    act(() => {
      (button!.props!.onClick as () => void)();
    });
    expect(
      findByText(
        renderer.toJSON() as Node | null,
        "This event could not be loaded.",
      ),
    ).toBe(true);
    clickButton(renderer, "Retry");
    expect(mocked.detailQuery.refetch).toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("seeds the lookup filter from ?ref= and passes a reference to the query", () => {
    mocked.search = "ref=a3f9c2e1";
    renderToStaticMarkup(<EventsPanel />);
    expect(mocked.listCalls[0]).toMatchObject({ reference: "a3f9c2e1" });
  });

  it("opens the newest matching event for a ?ref= deep link once it loads", () => {
    mocked.search = "ref=a3f9c2e1";
    mocked.detailQuery.data = { event: rows[0]!, body: null };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    const tree = renderer.toJSON() as Node | null;
    expect(findByText(tree, '\\"code\\": \\"OUTBOUND_NOT_ALLOWED\\"')).toBe(
      true,
    );
    expect(mocked.detailCalls.at(-1)).toMatchObject({ id: rows[0]!.id });
    act(() => renderer.unmount());
  });

  it("pages forward and back through cursors", () => {
    mocked.listQuery.data = { items: rows, nextCursor: "c1", truncated: true };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    const next = findByText(renderer.toJSON() as Node | null, "Next");
    expect(next).toBe(true);
    let nextButton: Node | undefined;
    walk(renderer.toJSON() as Node | null, (node) => {
      if (
        !nextButton &&
        node.children?.some((child) => child === ("Next" as unknown as Node))
      )
        nextButton = node;
    });
    act(() => {
      (nextButton!.props!.onClick as () => void)();
    });
    expect(mocked.listCalls.at(-1)).toMatchObject({ cursor: "c1" });
    let previousButton: Node | undefined;
    walk(renderer.toJSON() as Node | null, (node) => {
      if (
        !previousButton &&
        node.children?.some(
          (child) => child === ("Previous" as unknown as Node),
        )
      )
        previousButton = node;
    });
    act(() => {
      (previousButton!.props!.onClick as () => void)();
    });
    expect(mocked.listCalls.at(-1)).not.toMatchObject({ cursor: "c1" });
    act(() => renderer.unmount());
  });

  it("filters by document and job ids from the URL and clears them on request", () => {
    mocked.search =
      "documentId=11111111-1111-4111-8111-111111111111&jobId=job-7";
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<EventsPanel />);
    });
    expect(mocked.listCalls.at(-1)).toEqual({
      limit: 50,
      excludeDebug: true,
      documentId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-7",
    });
    expect(
      findByText(
        renderer.toJSON() as Node,
        "Document 11111111-1111-4111-8111-111111111111",
      ),
    ).toBe(true);
    clickButton(renderer, "Clear document");
    expect(mocked.replace).toHaveBeenCalledWith(
      "/admin/diagnostics?jobId=job-7",
      { scroll: false },
    );
  });
});
