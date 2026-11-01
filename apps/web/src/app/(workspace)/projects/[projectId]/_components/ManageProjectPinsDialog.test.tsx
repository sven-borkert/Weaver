import type { ReactNode } from "react";
import type { ProjectOverview } from "@weaver/core/dashboard/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManageProjectPinsDialog } from "./ManageProjectPinsDialog";

const fixture = vi.hoisted(() => {
  const candidates: { data: { items: unknown[] } | undefined; error: unknown } =
    { data: { items: [] }, error: null };
  return { candidates, query: vi.fn() };
});
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      dashboard: {
        projectOverview: { invalidate: vi.fn() },
        pinCandidates: { invalidate: vi.fn() },
      },
    }),
    dashboard: {
      pinCandidates: { useQuery: fixture.query },
      pin: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      unpin: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    },
  },
}));
vi.mock("~/components/ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: Wrapper,
    DialogClose: Wrapper,
    DialogContent: Wrapper,
    DialogDescription: Wrapper,
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: Wrapper,
  };
});
const overview: ProjectOverview = {
  project: {
    id: "9c378bfb-5bf5-4a5f-afdb-2f4a9bb26e97",
    name: "Demo",
    description: null,
    myRole: "Maintainer",
  },
  counts: {
    documents: { value: 1, capped: false },
    tables: { value: 0, capped: false },
  },
  pins: [{ pinId: "pin1", kind: "table", available: false }],
  pinCapacity: { used: 1, limit: 12 },
  canManagePins: true,
  workAudience: "projects",
  observedAt: "2026-09-09T08:00:00Z",
};
beforeEach(() => {
  fixture.candidates = { data: { items: [] }, error: null };
  fixture.query.mockReset().mockImplementation(() => ({
    ...fixture.candidates,
    isLoading: false,
    refetch: vi.fn(),
  }));
});
describe("ManageProjectPinsDialog", () => {
  it("shows capacity and allows removing unavailable shortcuts", () => {
    const html = renderToStaticMarkup(
      <ManageProjectPinsDialog
        overview={overview}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toContain("1 of 12 pins used");
    expect(html).toContain('aria-label="Remove Unavailable table"');
    expect(html).toContain("Removing a pin keeps its content");
    expect(html).toContain('maxLength="200"');
  });
  it("blocks cached candidate and pin metadata after access errors", () => {
    fixture.candidates.error = { data: { code: "FORBIDDEN" } };
    const html = renderToStaticMarkup(
      <ManageProjectPinsDialog
        overview={overview}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toContain("Content or access changed");
    expect(html).not.toContain("Remove Unavailable table");
    expect(html).not.toContain("Choose content to pin");
  });
  it("does not render or query candidates for readers", () => {
    const html = renderToStaticMarkup(
      <ManageProjectPinsDialog
        overview={{ ...overview, canManagePins: false }}
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toBe("");
    expect(fixture.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});
