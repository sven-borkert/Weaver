import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOverview } from "@weaver/core/dashboard/schema";
import { ProjectActivityScreen } from "./ProjectActivityScreen";

const fixture = vi.hoisted(() => ({
  snapshot: {} as {
    data?: ProjectOverview;
    error: unknown;
    isLoading: boolean;
  },
  work: vi.fn(),
  reports: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    dashboard: {
      projectOverview: {
        useQuery: () => ({ ...fixture.snapshot, refetch: vi.fn() }),
      },
      reports: { useQuery: fixture.reports },
    },
    backgroundWork: { list: { useQuery: fixture.work } },
  },
}));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  useBackgroundWork: () => ({ pageVisible: true }),
}));
vi.mock("~/components/dashboard/ActivityList", () => ({
  ActivityList: ({ audience }: { audience: string }) => (
    <h2 id="latest-activity-heading">Activity audience: {audience}</h2>
  ),
}));
vi.mock("./ManageProjectPinsDialog", () => ({
  ManageProjectPinsDialog: () => <span>Pin dialog</span>,
}));

const overview: ProjectOverview = {
  project: {
    id: "p1",
    name: "Private project",
    description: "A useful description",
    myRole: "Viewer",
  },
  counts: {
    documents: { value: 10000, capped: true },
    tables: { value: 2, capped: false },
  },
  pins: [],
  pinCapacity: null,
  canManagePins: false,
  workAudience: "mine",
  observedAt: "2026-09-09T08:00:00Z",
};

function render() {
  return renderToStaticMarkup(<ProjectActivityScreen projectId="p1" />);
}

beforeEach(() => {
  fixture.snapshot = { data: overview, error: null, isLoading: false };
  fixture.work.mockReset().mockReturnValue({
    data: { items: [] },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  });
  fixture.reports.mockReset().mockReturnValue({
    data: { items: [] },
    error: undefined,
    isLoading: false,
    refetch: () => Promise.resolve(),
  });
});
describe("ProjectActivityScreen", () => {
  it("renders active work, activity, pins and reports in order without count cards", () => {
    const html = render();
    const order = [
      'aria-label="Active work"',
      "latest-activity-heading",
      'aria-label="Pinned content"',
      "scheduled-reports-heading",
    ].map((marker) => html.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("9,999+");
    expect(html).not.toContain("Ask about this project");
    expect(html).toContain('aria-label="Project activity"');
  });
  it("requests reports for this project so the server filters before limiting", () => {
    render();
    expect(fixture.reports).toHaveBeenCalledWith(
      { projectId: "p1" },
      expect.anything(),
    );
  });
  it("requests active work for the server-provided audience", () => {
    render();
    expect(fixture.work).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "mine",
        projectId: "p1",
        view: "active",
        limit: 3,
      }),
      expect.objectContaining({ enabled: true }),
    );
  });
  it("uses server-provided shared work and curator controls", () => {
    fixture.snapshot.data = {
      ...overview,
      canManagePins: true,
      workAudience: "projects",
    };
    const html = render();
    expect(html).toContain("Activity audience: projects");
    expect(html).toContain("Manage pinned content");
    expect(fixture.work).toHaveBeenCalledWith(
      expect.objectContaining({ audience: "projects" }),
      expect.anything(),
    );
  });
  it("hides cached project content and disables work after access loss", () => {
    fixture.snapshot.error = { data: { code: "FORBIDDEN" } };
    const html = render();
    expect(html).not.toContain("Private project");
    expect(html).not.toContain("Activity audience");
    expect(html).toContain("Retry");
    expect(fixture.work).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
  it("retains clearly labeled stale content after a transient error", () => {
    fixture.snapshot.error = { data: { code: "INTERNAL_SERVER_ERROR" } };
    const html = render();
    expect(html).toContain("Private project");
    expect(html).toContain("out of date");
    expect(html).toContain("Project activity is unavailable.");
  });
});
