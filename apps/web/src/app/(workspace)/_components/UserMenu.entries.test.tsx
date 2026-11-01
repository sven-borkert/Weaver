import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(
  (): {
    query: {
      data: { name: string; email: string; role: string } | undefined;
      error: unknown;
      isLoading: boolean;
      refetch: () => Promise<unknown>;
    };
  } => ({
    query: {
      data: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "Admin",
      },
      error: undefined,
      isLoading: false,
      refetch: () => Promise.resolve(),
    },
  }),
);

vi.mock("~/lib/authClient", () => ({
  authClient: { signOut: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("~/lib/use-unsaved-changes-guard", () => ({
  confirmNavigation: vi.fn(),
  suppressUnsavedPrompt: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: { account: { me: { useQuery: () => mocked.query } } },
}));

// Radix's DropdownMenuContent portals and does not mount while closed, so
// static rendering never sees the menu items. Replace the primitives with
// plain pass-through markup so the entries render for assertion, the same
// way dialog tests mock ~/components/ui/dialog.
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="menu">{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { UserMenu } from "./UserMenu";

describe("UserMenu entries", () => {
  it("links to Remote instances, alongside the existing Connected apps entry", () => {
    const html = renderToStaticMarkup(<UserMenu />);

    expect(html).toContain('href="/account/remote-instances"');
    expect(html).toContain("Remote instances");
    // Control: an entry known to exist already, so this assertion would have
    // caught a mock that silently renders nothing.
    expect(html).toContain('href="/account/connected-apps"');
  });
});
