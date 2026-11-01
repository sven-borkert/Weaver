import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "~/trpc/react";

type Remote = RouterOutputs["remoteInstance"]["list"][number];

const mocked = vi.hoisted(() => ({
  list: undefined as Remote[] | undefined,
  error: undefined as { data: { code: string } } | undefined,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ remoteInstance: { invalidate: vi.fn() } }),
    remoteInstance: {
      list: {
        useQuery: () => ({
          data: mocked.list,
          error: mocked.error,
          isLoading: mocked.list === undefined && !mocked.error,
          refetch: vi.fn(),
        }),
      },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      update: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      test: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { RemoteInstancesScreen } from "./RemoteInstancesScreen";

describe("RemoteInstancesScreen", () => {
  it("shows the empty state with the add button", () => {
    mocked.list = [];
    const html = renderToStaticMarkup(<RemoteInstancesScreen />);
    expect(html).toContain("No remote instances yet");
    expect(html).toContain("Add remote instance");
  });

  it("lists remotes with status, last check and actions", () => {
    mocked.list = [
      {
        id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
        name: "Second",
        baseUrl: "https://b.example.com",
        enabled: true,
        revision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastCheckedAt: new Date("2026-09-28T10:00:00Z"),
        checkStatus: "unreachable",
        checkErrorSummary: "fetch failed",
      },
    ];
    const html = renderToStaticMarkup(<RemoteInstancesScreen />);
    expect(html).toContain("Second");
    expect(html).toContain("https://b.example.com");
    expect(html).toContain("Enabled");
    expect(html).toContain("Unreachable");
    expect(html).toContain("fetch failed");
    for (const label of ["Test", "Edit", "Disable", "Delete"])
      expect(html).toContain(label);
  });
});
