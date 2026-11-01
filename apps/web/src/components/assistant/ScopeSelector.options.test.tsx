import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real `PopoverContent` is a Radix portal into `document.body`, so the
// option rows never appear in static markup (see the note in
// ScopeSelector.tsx). This file replaces the three popover primitives with
// inline wrappers so the rows can be asserted; ScopeSelector.test.tsx keeps
// the real ones for the trigger.
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const ids = vi.hoisted(() => ({
  P: "11111111-1111-4111-8111-111111111111",
  PAGE_P: "22222222-2222-4222-8222-222222222222",
  D: "33333333-3333-4333-8333-333333333333",
  PAGE_D: "44444444-4444-4444-8444-444444444444",
  T: "55555555-5555-4555-8555-555555555555",
  PAGE_T: "66666666-6666-4666-8666-666666666666",
}));

const names = vi.hoisted((): Record<string, string> => ({
  "11111111-1111-4111-8111-111111111111": "Platform",
  "22222222-2222-4222-8222-222222222222": "Ops",
  "33333333-3333-4333-8333-333333333333": "Runbook",
  "44444444-4444-4444-8444-444444444444": "Page doc",
  "55555555-5555-4555-8555-555555555555": "Metrics",
  "66666666-6666-4666-8666-666666666666": "Page table",
}));

const lookup = (id: string, enabled: boolean | undefined) =>
  enabled === false || !names[id] ? undefined : names[id];

vi.mock("~/trpc/react", () => ({
  api: {
    assistant: {
      listScopeFolders: { useQuery: () => ({ data: undefined }) },
    },
    document: {
      get: {
        useQuery: (
          input: { documentId: string },
          opts?: { enabled?: boolean },
        ) => {
          const title = lookup(input.documentId, opts?.enabled);
          return { data: title ? { title } : undefined };
        },
      },
    },
    table: {
      get: {
        useQuery: (
          input: { tableId: string },
          opts?: { enabled?: boolean },
        ) => {
          const title = lookup(input.tableId, opts?.enabled);
          return { data: title ? { title } : undefined };
        },
      },
    },
    project: {
      get: {
        useQuery: (
          input: { projectId: string },
          opts?: { enabled?: boolean },
        ) => {
          const name = lookup(input.projectId, opts?.enabled);
          return { data: name ? { name } : undefined };
        },
      },
    },
  },
}));

import { ScopeSelector } from "./ScopeSelector";

/**
 * The markup of one `role="option"` row, from its own `aria-selected` up to
 * the next row — so an assertion cannot accidentally read a sibling's state.
 */
function optionRow(html: string, label: string): string {
  const row = html
    .split('role="option"')
    .slice(1)
    .find((segment) => segment.includes(label));
  if (!row) throw new Error(`no option row containing ${label}`);
  return row;
}

function render(props: Parameters<typeof ScopeSelector>[0]) {
  return renderToStaticMarkup(<ScopeSelector {...props} />);
}

describe("ScopeSelector option rows", () => {
  it("names the page's document, not the draft's, and is unselected while they differ", () => {
    // Draft pinned to Runbook (project Platform); the user has since
    // navigated to Page doc in another project. Choosing this row would
    // scope to Page doc, so that is what it must name — and it is not the
    // current scope.
    const html = render({
      draft: { kind: "document", projectId: ids.P, documentId: ids.D },
      onChange: () => undefined,
      page: { projectId: ids.PAGE_P, documentId: ids.PAGE_D },
      accessibleProjects: [{ id: ids.P, name: "Platform" }],
    });

    expect(html).toContain("Scope: Focus on this document · Runbook");

    const row = optionRow(html, "Focus on this document");
    expect(row).toContain("Page doc");
    expect(row).not.toContain("Runbook");
    expect(row).toContain('aria-selected="false"');
  });

  it("marks the project row unselected when the draft is pinned to another project", () => {
    const html = render({
      draft: { kind: "project", projectId: ids.P },
      onChange: () => undefined,
      page: { projectId: ids.PAGE_P },
      accessibleProjects: [{ id: ids.P, name: "Platform" }],
    });

    expect(html).toContain("Scope: Project · Platform");

    const row = optionRow(html, "This project");
    expect(row).toContain("Ops");
    expect(row).not.toContain("Platform");
    expect(row).toContain('aria-selected="false"');
  });

  it("names the page's table, not the draft's, and is unselected while they differ", () => {
    const html = render({
      draft: { kind: "table", projectId: ids.P, tableId: ids.T },
      onChange: () => undefined,
      page: { projectId: ids.P, tableId: ids.PAGE_T },
      accessibleProjects: [{ id: ids.P, name: "Platform" }],
    });

    expect(html).toContain("Scope: Focus on this table · Metrics");

    const row = optionRow(html, "Focus on this table");
    expect(row).toContain("Page table");
    expect(row).not.toContain("Metrics");
    expect(row).toContain('aria-selected="false"');
  });

  it("selects the row once the draft is the page's own document", () => {
    const html = render({
      draft: { kind: "document", projectId: ids.P, documentId: ids.D },
      onChange: () => undefined,
      page: { projectId: ids.P, documentId: ids.D },
      accessibleProjects: [{ id: ids.P, name: "Platform" }],
    });

    const row = optionRow(html, "Focus on this document");
    expect(row).toContain("Runbook");
    expect(row).toContain('aria-selected="true"');
    expect(optionRow(html, "This project")).toContain('aria-selected="false"');
  });
});
