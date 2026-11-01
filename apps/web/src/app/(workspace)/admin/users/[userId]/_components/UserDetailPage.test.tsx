import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccessCard } from "./AccessCard";
import { AccountCard } from "./AccountCard";
import { MembershipsCard } from "./MembershipsCard";

describe("AccountCard", () => {
  it("renders the user's email and global role", () => {
    const html = renderToStaticMarkup(
      <AccountCard
        name="Person"
        email="person@test.local"
        role="User"
        active={true}
        banReason={null}
        isSelf={false}
        onChangeRole={vi.fn()}
        rolePending={false}
      />,
    );

    expect(html).toContain("person@test.local");
    expect(html).toContain("User");
    expect(html).toContain("Active");
  });

  it("shows why the role select is disabled when viewing your own account", () => {
    const html = renderToStaticMarkup(
      <AccountCard
        name="Admin"
        email="admin@test.local"
        role="Admin"
        active={true}
        banReason={null}
        isSelf={true}
        onChangeRole={vi.fn()}
        rolePending={false}
      />,
    );

    expect(html).toContain("You cannot change your own global role.");
  });

  it("marks a deactivated user", () => {
    const html = renderToStaticMarkup(
      <AccountCard
        name="Person"
        email="person@test.local"
        role="User"
        active={false}
        banReason="left the company"
        isSelf={false}
        onChangeRole={vi.fn()}
        rolePending={false}
      />,
    );

    expect(html).toContain("Deactivated");
  });
});

describe("AccessCard", () => {
  it("renders the Deactivate and Reset password controls", () => {
    const html = renderToStaticMarkup(
      <AccessCard
        email="person@test.local"
        active={true}
        banReason={null}
        isSelf={false}
        onDeactivate={vi.fn()}
        deactivatePending={false}
        onReactivate={vi.fn()}
        reactivatePending={false}
        onResetPassword={vi.fn()}
        resetPasswordPending={false}
        revealedPassword={null}
        onCloseReveal={vi.fn()}
        onRevokeSessions={vi.fn()}
        revokeSessionsPending={false}
      />,
    );

    expect(html).toContain("Deactivate");
    expect(html).toContain("Reset password");
    expect(html).toContain("Revoke sessions");
  });

  it("offers Reactivate instead of Deactivate for a deactivated account", () => {
    const html = renderToStaticMarkup(
      <AccessCard
        email="person@test.local"
        active={false}
        banReason="left the company"
        isSelf={false}
        onDeactivate={vi.fn()}
        deactivatePending={false}
        onReactivate={vi.fn()}
        reactivatePending={false}
        onResetPassword={vi.fn()}
        resetPasswordPending={false}
        revealedPassword={null}
        onCloseReveal={vi.fn()}
        onRevokeSessions={vi.fn()}
        revokeSessionsPending={false}
      />,
    );

    expect(html).toContain("Reactivate");
    expect(html).toContain("left the company");
  });

  it("shows why deactivate and reset password are disabled for your own account", () => {
    const html = renderToStaticMarkup(
      <AccessCard
        email="admin@test.local"
        active={true}
        banReason={null}
        isSelf={true}
        onDeactivate={vi.fn()}
        deactivatePending={false}
        onReactivate={vi.fn()}
        reactivatePending={false}
        onResetPassword={vi.fn()}
        resetPasswordPending={false}
        revealedPassword={null}
        onCloseReveal={vi.fn()}
        onRevokeSessions={vi.fn()}
        revokeSessionsPending={false}
      />,
    );

    expect(html).toContain(
      "You cannot deactivate your own account. Change your own password from Account settings.",
    );
  });
});

describe("MembershipsCard", () => {
  const memberships = [
    {
      projectId: "22222222-2222-2222-2222-222222222222",
      projectName: "Demo Project",
      role: "Editor" as const,
    },
  ];

  it("renders the membership rows", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard
        memberships={memberships}
        projects={[]}
        isSelf={false}
        onSetMembership={vi.fn()}
        pending={false}
      />,
    );

    expect(html).toContain("Demo Project");
    expect(html).toContain("Editor");
    expect(html).toContain("Add to project");
  });

  it("shows why membership controls are disabled when viewing your own account", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard
        memberships={memberships}
        projects={[]}
        isSelf={true}
        onSetMembership={vi.fn()}
        pending={false}
      />,
    );

    expect(html).toContain("You cannot change your own project memberships.");
  });
});

const mutation = vi.hoisted(() => ({
  capturedResetPasswordOptions: undefined as
    Record<string, unknown> | undefined,
}));

const fixture = vi.hoisted(() => ({
  userId: "11111111-1111-1111-1111-111111111111",
  user: {
    id: "11111111-1111-1111-1111-111111111111",
    email: "person@test.local",
    name: "Person",
    role: "User" as const,
    active: true,
    banReason: null,
    lastLoginAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    mustChangePassword: false,
    memberships: [
      {
        projectId: "22222222-2222-2222-2222-222222222222",
        projectName: "Demo Project",
        role: "Editor" as const,
      },
    ],
  },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ user: { get: { invalidate: vi.fn() } } }),
    account: {
      me: {
        useQuery: () => ({
          data: {
            id: "admin-id",
            email: "admin@test.local",
            name: "Admin",
            role: "Admin",
          },
        }),
      },
    },
    user: {
      get: {
        useQuery: () => ({
          data: fixture.user,
          error: undefined,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
      listProjects: {
        useQuery: () => ({ data: [], error: undefined }),
      },
      setRole: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      deactivate: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      reactivate: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      resetPassword: {
        useMutation: (options: Record<string, unknown>) => {
          mutation.capturedResetPasswordOptions = options;
          return { isPending: false, mutate: vi.fn(), reset: vi.fn() };
        },
      },
      revokeSessions: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      setMembership: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
    },
  },
}));

import { UserDetailPage } from "./UserDetailPage";

describe("UserDetailPage", () => {
  it("sets gcTime: 0 on the reset-password mutation so the plaintext password does not linger in the query cache", () => {
    renderToStaticMarkup(<UserDetailPage userId={fixture.userId} />);

    // Regression guard: without gcTime: 0, TanStack Query's default 5-minute
    // gcTime leaves the mutation (and its plaintext password result) in the
    // QueryClient's mutation cache — reachable via getMutationCache(),
    // useMutationState(), or the React Query Devtools — for up to five
    // minutes after the reveal dialog closes.
    expect(mutation.capturedResetPasswordOptions?.gcTime).toBe(0);
  });

  it("renders the loaded user's cards, including the membership table", () => {
    const html = renderToStaticMarkup(
      <UserDetailPage userId={fixture.userId} />,
    );

    expect(html).toContain("person@test.local");
    expect(html).toContain("Demo Project");
    expect(html).toContain("Deactivate");
    expect(html).toContain("Reset password");
  });
});
