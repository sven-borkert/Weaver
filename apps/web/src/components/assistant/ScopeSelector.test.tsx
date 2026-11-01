import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const ids = vi.hoisted(() => ({
  P: "11111111-1111-4111-8111-111111111111",
  OTHER_P: "22222222-2222-4222-8222-222222222222",
  D: "33333333-3333-4333-8333-333333333333",
  PAGE_D: "44444444-4444-4444-8444-444444444444",
}));

// Arg-aware so a draft/page mismatch resolves to two different titles: the
// component must query (and label with) the draft's document, not the page's.
const documentTitles = vi.hoisted((): Record<string, string> => ({
  "33333333-3333-4333-8333-333333333333": "Runbook",
  "44444444-4444-4444-8444-444444444444": "Page doc",
}));

vi.mock("~/trpc/react", () => ({
  api: {
    assistant: {
      listScopeFolders: { useQuery: () => ({ data: undefined }) },
    },
    document: {
      get: {
        useQuery: (
          input: { projectId: string; documentId: string },
          opts?: { enabled?: boolean },
        ) => {
          const title = documentTitles[input.documentId];
          return {
            data: opts?.enabled === false || !title ? undefined : { title },
          };
        },
      },
    },
    table: { get: { useQuery: () => ({ data: undefined }) } },
    project: { get: { useQuery: () => ({ data: { name: "Platform" } }) } },
  },
}));

import { ScopeSelector, scopeOptions } from "./ScopeSelector";

const P = ids.P;
const D = ids.D;

describe("scopeOptions", () => {
  it("offers page-specific options only when the page has them", () => {
    expect(scopeOptions({ projectId: P, documentId: D })).toEqual([
      "document",
      "project",
    ]);
    expect(scopeOptions({ projectId: P, tableId: D })).toEqual([
      "table",
      "project",
    ]);
    expect(scopeOptions({ projectId: P })).toEqual(["project"]);
    expect(scopeOptions({})).toEqual([]);
  });
});

describe("ScopeSelector", () => {
  it("labels the trigger with the current draft and a resolved name", () => {
    const html = renderToStaticMarkup(
      <ScopeSelector
        draft={{ kind: "document", projectId: P, documentId: D }}
        onChange={() => undefined}
        page={{ projectId: P, documentId: D }}
        accessibleProjects={[{ id: P, name: "Platform" }]}
      />,
    );
    expect(html).toContain("Focus on this document · Runbook");
    expect(html).toMatch(/aria-haspopup="dialog"/);
  });

  it("names the draft's document, not the page's, once they diverge", () => {
    // The panel is docked: the draft seeded to document D, then the user
    // navigated to a different document. deriveScopeDraftState keeps the
    // draft on D (spec §6.2), so the button must keep naming D (§6.3).
    const html = renderToStaticMarkup(
      <ScopeSelector
        draft={{ kind: "document", projectId: P, documentId: D }}
        onChange={() => undefined}
        page={{ projectId: ids.OTHER_P, documentId: ids.PAGE_D }}
        accessibleProjects={[{ id: P, name: "Platform" }]}
      />,
    );
    expect(html).toContain("Focus on this document · Runbook");
    expect(html).not.toContain("Page doc");
  });

  it("names the truncation when the draft is all and the last snapshot was truncated", () => {
    const html = renderToStaticMarkup(
      <ScopeSelector
        draft={{ kind: "all" }}
        onChange={() => undefined}
        page={{}}
        accessibleProjects={Array.from({ length: 3 }, (_, i) => ({
          id: `${i}`,
          name: `P${i}`,
        }))}
        truncated
      />,
    );
    expect(html).toContain("All projects (3)");
    expect(html).toContain("limited to 100");
  });
});
