import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted((): { list: unknown } => ({ list: undefined }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ remoteInstance: { invalidate: vi.fn() } }),
    remoteInstance: {
      listForUser: {
        useQuery: () => ({
          data: mocked.list,
          error: undefined,
          isLoading: mocked.list === undefined,
        }),
      },
      connect: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      disconnect: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { RemoteInstancesCard } from "./RemoteInstancesCard";

describe("RemoteInstancesCard", () => {
  it("offers Connect for an unconnected remote and Disconnect for a connected one", () => {
    mocked.list = [
      {
        id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
        name: "Second",
        baseUrl: "https://b.example.com",
        connection: null,
      },
      {
        id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
        name: "Third",
        baseUrl: "https://c.example.com",
        connection: {
          remoteUserName: "Ada",
          connectedAt: new Date("2026-09-01T00:00:00Z"),
          lastUsedAt: null,
        },
      },
    ];
    const html = renderToStaticMarkup(<RemoteInstancesCard notice={null} />);
    expect(html).toContain("Second");
    expect(html).toContain("Connect");
    expect(html).toContain("Connected as Ada");
    expect(html).toContain("Disconnect");
  });

  it("explains when no remote instances are registered", () => {
    mocked.list = [];
    expect(
      renderToStaticMarkup(<RemoteInstancesCard notice={null} />),
    ).toContain("No remote instances are registered");
  });
});
