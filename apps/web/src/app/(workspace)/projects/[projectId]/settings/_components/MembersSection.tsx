"use client";

import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { AddMemberDialog, PROJECT_ROLES } from "./AddMemberDialog";

type MemberRow = RouterOutputs["projectMember"]["list"][number];

function GlobalRoleBadge({ role }: { role: string }) {
  return (
    <Badge variant={role === "Admin" ? "default" : "secondary"}>{role}</Badge>
  );
}

export function MembersSection({
  projectId,
  myRole,
  canManage,
}: {
  projectId: string;
  myRole: string;
  canManage: boolean;
}) {
  const utils = api.useUtils();
  const membersQuery = api.projectMember.list.useQuery({
    projectId,
  });
  const presentation = resolveQueryPresentation(membersQuery);
  const members = dataUnlessAccessError(membersQuery.data, membersQuery.error);
  const grantableRoles = PROJECT_ROLES.filter(
    (role) =>
      myRole === "Owner" ||
      (myRole === "Maintainer" && (role === "Editor" || role === "Viewer")),
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const removedRef = useRef(false);
  const { data: me } = api.account.me.useQuery();
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);

  const updateRole = api.projectMember.updateRole.useMutation({
    onSuccess: () => {
      void utils.account.landingProject.invalidate();
      void utils.projectMember.list.invalidate({ projectId });
    },
    onError: (err) => {
      toast.error(err.message || "Could not update the role");
      void utils.account.landingProject.invalidate();
      void utils.projectMember.list.invalidate({ projectId });
    },
  });

  const setTrainingRole = api.projectMember.setTrainingRole.useMutation({
    onSuccess: () => {
      void utils.projectMember.list.invalidate({ projectId });
      void utils.project.get.invalidate({ projectId });
    },
    onError: (err) =>
      toast.error(err.message || "Could not update training role"),
  });

  const removeMember = api.projectMember.remove.useMutation({
    onSuccess: () => {
      toast.success("Member removed");
      removedRef.current = true;
      setRemoveTarget(null);
      void utils.account.landingProject.invalidate();
      void utils.projectMember.list.invalidate({ projectId });
    },
    onError: (err) => {
      toast.error(err.message || "Could not remove the member");
      setRemoveTarget(null);
      void utils.account.landingProject.invalidate();
      void utils.projectMember.list.invalidate({ projectId });
    },
  });

  return (
    <Card
      ref={cardRef}
      role="region"
      aria-label="Project members"
      tabIndex={-1}
    >
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          Who has access to this project and with which role.
        </CardDescription>
        {canManage ? (
          <CardAction>
            <AddMemberDialog
              projectId={projectId}
              grantableRoles={grantableRoles}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {presentation === "loading" ? (
          <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : presentation === "error" ? (
          <div role="alert">
            Could not load members.{" "}
            <Button
              disabled={membersQuery.isFetching}
              onClick={() => void membersQuery.refetch()}
            >
              {membersQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Global role</TableHead>
                <TableHead>Project role</TableHead>
                <TableHead>Training</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members ?? []).map((member) => {
                const isSelf = member.userId === me?.id;
                const canChange =
                  canManage &&
                  !isSelf &&
                  (myRole === "Owner" ||
                    member.role === "Editor" ||
                    member.role === "Viewer");
                return (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <div className="text-text text-[13px] font-medium">
                        {member.user.name ?? member.email}
                      </div>
                      <div className="text-text-3 text-[12px]">
                        {member.email}
                      </div>
                    </TableCell>
                    <TableCell>
                      <GlobalRoleBadge role={member.user.role} />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={member.role}
                        disabled={!canChange || updateRole.isPending}
                        onValueChange={(value) => {
                          updateRole.mutate({
                            projectId,
                            userId: member.userId,
                            role: value as MemberRow["role"],
                          });
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-32"
                          aria-label={`Project role for ${member.email}`}
                        >
                          <SelectValue>{member.role}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {grantableRoles.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={member.trainingRole ?? "off"}
                        disabled={!canManage || setTrainingRole.isPending}
                        onValueChange={(value) =>
                          setTrainingRole.mutate({
                            projectId,
                            userId: member.userId,
                            role:
                              value === "off"
                                ? null
                                : (value as "trainer" | "trainee"),
                          })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-32"
                          aria-label={`Training for ${member.email}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">Off</SelectItem>
                          <SelectItem value="trainer">Trainer</SelectItem>
                          <SelectItem value="trainee">Trainee</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {!canChange ? null : (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!canManage || removeMember.isPending}
                          aria-label={`Remove ${member.email}`}
                          onClick={(event) => {
                            triggerRef.current = event.currentTarget;
                            removedRef.current = false;
                            setRemoveTarget(member);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {!canManage ? (
          <p className="text-text-3 mt-3 mb-0 text-[12px]">
            Your role ({myRole}) cannot manage members.
          </p>
        ) : null}
      </CardContent>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (removeMember.isPending) return;
          if (!nextOpen) setRemoveTarget(null);
        }}
      >
        <DialogContent
          aria-busy={removeMember.isPending || undefined}
          showCloseButton={!removeMember.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(
              removedRef.current ? null : triggerRef.current,
              cardRef.current,
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Remove {removeTarget?.email} from this project? They will lose
              access immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={removeMember.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={removeMember.isPending || removeTarget === null}
              onClick={() => {
                if (removeTarget) {
                  removeMember.mutate({
                    projectId,
                    userId: removeTarget.userId,
                  });
                }
              }}
            >
              {removeMember.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
