"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { AccessCard } from "./AccessCard";
import { AccountCard } from "./AccountCard";
import { MembershipsCard } from "./MembershipsCard";

function UserDetailSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

/** Data-fetching and mutation container; the three cards stay presentational. */
export function UserDetailPage({ userId }: { userId: string }) {
  const utils = api.useUtils();
  // Owns the one-time reveal; cleared by RevealPasswordDialog's onClose and
  // never written anywhere else (no cache, no storage, no logging).
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);

  const userQuery = api.user.get.useQuery({ userId });
  const meQuery = api.account.me.useQuery();
  // Every non-deleted project, not just ones the signed-in Admin belongs to
  // — the picker must reach the orphaned-project rescue setUserMembership
  // exists for (spec §6.1), which project.list can't (it's scoped to the
  // caller's own memberships).
  const projectsQuery = api.user.listProjects.useQuery();

  const user = dataUnlessAccessError(userQuery.data, userQuery.error);
  const presentation = resolveQueryPresentation({
    data: user,
    error: userQuery.error,
    isLoading: userQuery.isLoading,
  });

  const invalidate = () => void utils.user.get.invalidate({ userId });

  const setRole = api.user.setRole.useMutation({
    onSuccess: () => {
      toast.success("Global role updated");
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not update the role");
    },
  });

  const deactivate = api.user.deactivate.useMutation({
    onSuccess: () => {
      toast.success("User deactivated");
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not deactivate the user");
    },
  });

  const reactivate = api.user.reactivate.useMutation({
    onSuccess: () => {
      toast.success("User reactivated");
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not reactivate the user");
    },
  });

  const resetPassword = api.user.resetPassword.useMutation({
    // The success result carries a plaintext password. gcTime: 0 evicts the
    // mutation (and its cached result) from the QueryClient as soon as this
    // observer detaches — reset() on close below detaches it; gcTime: 0
    // makes that eviction near-immediate instead of the 5-minute default,
    // and also covers an unmount without ever clicking "Done" on the reveal.
    gcTime: 0,
    onSuccess: (result) => {
      toast.success("Password reset");
      invalidate();
      setRevealedPassword(result.password);
    },
    onError: (err) => {
      toast.error(err.message || "Could not reset the password");
    },
  });

  const revokeSessions = api.user.revokeSessions.useMutation({
    onSuccess: () => {
      toast.success("Sessions revoked");
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not revoke sessions");
    },
  });

  const setMembership = api.user.setMembership.useMutation({
    onSuccess: () => {
      toast.success("Membership updated");
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not update the membership");
    },
  });

  if (presentation === "loading") return <UserDetailSkeleton />;
  if (presentation === "error" || !user) {
    return (
      <div className="border-danger-border bg-danger-bg flex w-full flex-col items-start gap-3 rounded-xl border p-5">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          User unavailable
        </h1>
        <p className="text-danger m-0 text-[13px]">Could not load this user.</p>
        <Button variant="outline" onClick={() => void userQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const isSelf = meQuery.data?.id === userId;
  const projects =
    dataUnlessAccessError(projectsQuery.data, projectsQuery.error) ?? [];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">{user.name}</h1>
        <p className="text-text-3 m-0 text-[13px]">{user.email}</p>
      </div>

      <AccountCard
        name={user.name}
        email={user.email}
        role={user.role}
        active={user.active}
        banReason={user.banReason}
        isSelf={isSelf}
        onChangeRole={(role) => setRole.mutate({ userId, role })}
        rolePending={setRole.isPending}
      />

      <AccessCard
        email={user.email}
        active={user.active}
        banReason={user.banReason}
        isSelf={isSelf}
        onDeactivate={(reason) => deactivate.mutate({ userId, reason })}
        deactivatePending={deactivate.isPending}
        onReactivate={() => reactivate.mutate({ userId })}
        reactivatePending={reactivate.isPending}
        onResetPassword={(password) =>
          resetPassword.mutate({ userId, password })
        }
        resetPasswordPending={resetPassword.isPending}
        revealedPassword={revealedPassword}
        onCloseReveal={() => {
          setRevealedPassword(null);
          // Drops the mutation's cached result so the plaintext password
          // doesn't linger in the mutation's own state after the dialog
          // closes (see the gcTime: 0 comment above).
          resetPassword.reset();
        }}
        onRevokeSessions={() => revokeSessions.mutate({ userId })}
        revokeSessionsPending={revokeSessions.isPending}
      />

      <MembershipsCard
        memberships={user.memberships}
        projects={projects}
        isSelf={isSelf}
        onSetMembership={(projectId, role) =>
          setMembership.mutate({ userId, projectId, role })
        }
        pending={setMembership.isPending}
      />
    </div>
  );
}
