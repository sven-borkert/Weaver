import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MeQuery = {
  data: { name: string; email: string; role: string } | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

const mocked = vi.hoisted(() => {
  const query: MeQuery = {
    data: undefined,
    error: undefined,
    isLoading: true,
    refetch: () => Promise.resolve(),
  };
  return {
    query,
    signOut: vi.fn(),
    confirmNavigation: vi.fn(),
    restorePrompt: vi.fn(),
    suppressUnsavedPrompt: vi.fn(),
    toastError: vi.fn(),
  };
});

vi.mock("~/lib/authClient", () => ({
  authClient: { signOut: mocked.signOut },
}));

vi.mock("sonner", () => ({ toast: { error: mocked.toastError } }));

vi.mock("~/lib/use-unsaved-changes-guard", () => ({
  confirmNavigation: mocked.confirmNavigation,
  suppressUnsavedPrompt: mocked.suppressUnsavedPrompt,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("~/trpc/react", () => ({
  api: { account: { me: { useQuery: () => mocked.query } } },
}));

import { signOutWithGuard, UserMenu } from "./UserMenu";

describe("UserMenu", () => {
  beforeEach(() => {
    mocked.query.data = undefined;
    mocked.query.error = undefined;
    mocked.query.isLoading = true;
  });

  it("renders a degraded state with a retry control on error", () => {
    mocked.query.isLoading = false;
    mocked.query.error = new Error("session lookup failed");

    const html = renderToStaticMarkup(<UserMenu />);

    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).toContain(">?<");
    expect(html).toContain('aria-label="Retry loading account"');
    expect(html).not.toContain("session lookup failed");
  });

  it("shows skeletons while the account is loading", () => {
    const html = renderToStaticMarkup(<UserMenu />);

    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("Retry loading account");
  });

  it("shows initials once the account loads", () => {
    mocked.query.isLoading = false;
    mocked.query.data = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "Admin",
    };

    const html = renderToStaticMarkup(<UserMenu />);

    expect(html).toContain(">AL<");
    expect(html).not.toContain("Retry loading account");
  });
});

describe("signOutWithGuard", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.suppressUnsavedPrompt.mockReturnValue(mocked.restorePrompt);
    mocked.signOut.mockResolvedValue({ error: null });
    vi.stubGlobal("window", { location: { replace } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the session and the draft when the discard prompt is declined", async () => {
    mocked.confirmNavigation.mockReturnValue(false);

    await signOutWithGuard();

    expect(mocked.confirmNavigation).toHaveBeenCalledWith("/login");
    expect(mocked.signOut).not.toHaveBeenCalled();
    expect(mocked.suppressUnsavedPrompt).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("signs out without a second native prompt once the discard is confirmed", async () => {
    mocked.confirmNavigation.mockReturnValue(true);

    await signOutWithGuard();

    expect(mocked.suppressUnsavedPrompt).toHaveBeenCalledOnce();
    expect(
      mocked.suppressUnsavedPrompt.mock.invocationCallOrder[0],
    ).toBeLessThan(mocked.signOut.mock.invocationCallOrder[0]!);
    expect(mocked.signOut).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login");
    expect(mocked.restorePrompt).not.toHaveBeenCalled();
  });

  it("restores the unsaved-changes prompt when sign-out fails", async () => {
    mocked.confirmNavigation.mockReturnValue(true);
    mocked.signOut.mockResolvedValue({ error: { message: "nope" } });

    await signOutWithGuard();

    expect(replace).not.toHaveBeenCalled();
    expect(mocked.restorePrompt).toHaveBeenCalledOnce();
    expect(mocked.toastError).toHaveBeenCalledWith("Could not sign out");
  });
});
