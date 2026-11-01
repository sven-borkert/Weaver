import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityState } from "~/lib/dashboard/activityState";
import { ActivityList } from "./ActivityList";
const fixture = vi.hoisted(() => {
  const values: {
    state: ActivityState;
    error: unknown;
    refresh: (() => void) | undefined;
  } = {
    state: { view: "all", projectId: "p1", cursors: [null, "cursor"], page: 1 },
    error: null,
    refresh: undefined,
  };
  return {
    ...values,
    dispatch: vi.fn(),
    invalidate: vi.fn(),
    query: vi.fn(),
    refetch: vi.fn(),
  };
});
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof React>("react")),
  useReducer: () => [fixture.state, fixture.dispatch],
}));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  useBackgroundWork: () => ({ pageVisible: true }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      dashboard: { activity: { invalidate: fixture.invalidate } },
    }),
    dashboard: { activity: { useQuery: fixture.query } },
    project: { list: { useQuery: () => ({ data: [], error: null }) } },
  },
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: React.ComponentProps<"button">) => {
    if (children === "Refresh") fixture.refresh = onClick as () => void;
    return <button {...props}>{children}</button>;
  },
}));
beforeEach(() => {
  fixture.state = {
    view: "all",
    projectId: "p1",
    cursors: [null, "cursor"],
    page: 1,
  };
  fixture.error = null;
  fixture.dispatch.mockClear();
  fixture.invalidate.mockReset().mockResolvedValue(undefined);
  fixture.refetch.mockClear();
  fixture.query.mockReset().mockImplementation(() => ({
    data: { items: [], nextCursor: null },
    error: fixture.error,
    isLoading: false,
    isFetching: false,
    refetch: fixture.refetch,
  }));
});
describe("ActivityList", () => {
  it("invalidates only the first page before resetting a continuation on Refresh", () => {
    renderToStaticMarkup(<ActivityList projectId="p1" audience="projects" />);
    fixture.refresh!();
    expect(fixture.invalidate).toHaveBeenCalledWith(
      {
        audience: "projects",
        projectId: "p1",
        view: "all",
        limit: 20,
        cursor: undefined,
      },
      { exact: true, refetchType: "none" },
    );
    expect(fixture.invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.dispatch.mock.invocationCallOrder[0]!,
    );
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "refresh" });
    expect(fixture.refetch).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        refetchInterval: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      }),
    );
  });
  it("explicitly fetches a new snapshot when already on the first page", () => {
    fixture.state = { ...fixture.state, cursors: [null], page: 0 };
    renderToStaticMarkup(<ActivityList projectId="p1" />);
    fixture.refresh!();
    expect(fixture.refetch).toHaveBeenCalledOnce();
  });
  it("clearly labels stale data with an alert and Retry", () => {
    fixture.error = { data: { code: "INTERNAL_SERVER_ERROR" } };
    const html = renderToStaticMarkup(<ActivityList projectId="p1" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("out of date");
    expect(html).toContain("Retry");
  });
});
