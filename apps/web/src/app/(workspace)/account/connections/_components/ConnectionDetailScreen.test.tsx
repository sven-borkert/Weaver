import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{ query: Record<string, unknown> }>(() => ({
  query: {},
}));
const nav = vi.hoisted(() => ({ replace: vi.fn(), discover: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("./ConnectionDialog", () => ({ ConnectionDialog: () => null }));
vi.mock("./ToolCatalog", () => ({ ToolCatalog: () => null }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ externalMcp: { invalidate: vi.fn() } }),
    externalMcp: {
      get: { useQuery: () => state.query },
      discover: {
        useMutation: () => ({ isPending: false, mutate: nav.discover }),
      },
      update: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      delete: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    },
  },
}));

import { ConnectionDetailScreen } from "./ConnectionDetailScreen";

const connection = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Broken service",
  endpoint: "https://example.test/mcp",
  enabled: false,
  authMode: "none",
  revision: 2,
  timeoutMs: 30000,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastDiscoveredAt: new Date(),
  discoveryProtocol: null,
  discoveryServerName: null,
  discoveryToolCount: 0,
  discoveryResourceCount: 0,
  discoveryErrorCode: "INVALID_CATALOG",
  discoveryErrorSummary: "External MCP discovery failed",
  tools: [],
  totalTools: 0,
  toolsTruncated: false,
};

describe("ConnectionDetailScreen states", () => {
  beforeEach(() => {
    state.query = {
      data: undefined,
      error: null,
      isLoading: true,
      refetch: vi.fn(),
    };
  });
  it("renders loading and access-loss states", () => {
    expect(
      renderToStaticMarkup(<ConnectionDetailScreen connectionId="id" />),
    ).toContain("animate-pulse");
    state.query = {
      data: undefined,
      error: { data: { code: "UNAUTHORIZED" } },
      isLoading: false,
      refetch: vi.fn(),
    };
    expect(
      renderToStaticMarkup(<ConnectionDetailScreen connectionId="id" />),
    ).toContain("Access was lost");
  });
  it("renders a discovery failure and retry control", () => {
    state.query = {
      data: connection,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    const html = renderToStaticMarkup(
      <ConnectionDetailScreen connectionId="id" />,
    );
    expect(html).toContain("Failed (INVALID_CATALOG)");
    expect(html).toContain("Test and discover");
  });
  it("shows the accept-any-certificate indicator only when allowInsecureTls is set", () => {
    state.query = {
      data: { ...connection, allowInsecureTls: true },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    expect(
      renderToStaticMarkup(<ConnectionDetailScreen connectionId="id" />),
    ).toContain("Accepts any certificate");
    state.query = {
      data: { ...connection, allowInsecureTls: false },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    expect(
      renderToStaticMarkup(<ConnectionDetailScreen connectionId="id" />),
    ).not.toContain("Accepts any certificate");
  });
  it("discovers once when arriving from the add dialog", async () => {
    const { act, create } = await import("react-test-renderer");
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const fresh = {
      ...connection,
      lastDiscoveredAt: null,
      discoveryErrorCode: null,
      discoveryErrorSummary: null,
    };
    state.query = {
      data: fresh,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    await act(async () => {
      create(<ConnectionDetailScreen connectionId="id" autoDiscover />);
    });
    expect(nav.discover).toHaveBeenCalledTimes(1);
    expect(nav.discover).toHaveBeenCalledWith({
      id: connection.id,
      expectedRevision: connection.revision,
    });
    expect(nav.replace).toHaveBeenCalledWith(
      `/account/connections/${connection.id}`,
    );
    nav.discover.mockClear();
    state.query = {
      data: { ...fresh, lastDiscoveredAt: new Date() },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    };
    await act(async () => {
      create(<ConnectionDetailScreen connectionId="id" autoDiscover />);
    });
    expect(nav.discover).not.toHaveBeenCalled();
  });
});
