import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
  capturedOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    account: {
      changePassword: {
        useMutation: (options: Record<string, unknown>) => {
          mutation.capturedOptions = options;
          return { isPending: false, mutate: vi.fn(), reset: vi.fn() };
        },
      },
    },
  },
}));

import { ChangePasswordCard } from "./ChangePasswordCard";

describe("ChangePasswordCard", () => {
  it("renders the current, new, and confirm password fields", () => {
    const html = renderToStaticMarkup(<ChangePasswordCard />);

    expect(html).toContain("Current password");
    expect(html).toContain("New password");
    expect(html).toContain("Confirm new password");
  });

  it("does not show the forced-change banner by default", () => {
    const html = renderToStaticMarkup(<ChangePasswordCard />);

    expect(html).not.toContain("administrator");
  });

  it("renders the forced-change banner when forced", () => {
    const html = renderToStaticMarkup(<ChangePasswordCard forced />);

    expect(html).toContain("administrator");
    expect(html).toContain("must change it before continuing");
    // Still renders the same three fields.
    expect(html).toContain("Current password");
    expect(html).toContain("New password");
    expect(html).toContain("Confirm new password");
  });

  it("sets gcTime: 0 on the change-password mutation so the plaintext passwords do not linger in the query cache", () => {
    renderToStaticMarkup(<ChangePasswordCard />);

    // Regression guard: without gcTime: 0, TanStack Query's default 5-minute
    // gcTime leaves the mutation (and its plaintext current/new password
    // variables) in the QueryClient's mutation cache — reachable via
    // getMutationCache(), useMutationState(), or the React Query Devtools —
    // for up to five minutes after a successful change.
    expect(mutation.capturedOptions?.gcTime).toBe(0);
  });
});
