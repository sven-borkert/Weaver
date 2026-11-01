import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "~/components/ui/tooltip";

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ apiKey: { list: { invalidate: vi.fn() } } }),
    apiKey: {
      create: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      update: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      revoke: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      list: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          data: [
            {
              id: "key-1",
              name: "Admin key",
              start: "wvr_abcd",
              capabilities: ["system:admin", "ingest:external"],
              projectIds: [],
              expiresAt: null,
              lastUsedAt: null,
              rateLimitPerMinute: null,
              enabled: true,
            },
          ],
        }),
      },
    },
    project: { list: { useQuery: () => ({ data: [] }) } },
  },
  type: {},
}));

import { ApiKeysCard } from "./ApiKeysCard";

const render = (isAdmin: boolean) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ApiKeysCard isAdmin={isAdmin} />
    </TooltipProvider>,
  );

describe("ApiKeysCard", () => {
  it("labels the external feed capability as Import", () => {
    expect(render(true)).toContain(">Import<");
  });

  it("labels a system administration capability as Admin", () => {
    const markup = render(true);
    expect(markup).toContain(">Admin<");
    expect(markup).not.toContain("inactive while you are not an Admin");
  });

  it("offers an edit action for every key", () => {
    expect(render(true)).toContain('aria-label="Edit Admin key"');
  });

  it("marks a system administration grant dormant while the owner is not an Admin", () => {
    const markup = render(false);
    expect(markup).toContain('data-variant="outline"');
    expect(markup).toContain("(inactive while you are not an Admin)");
  });
});
