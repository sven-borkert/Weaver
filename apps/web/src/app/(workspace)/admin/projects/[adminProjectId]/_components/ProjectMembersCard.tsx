"use client";

import { PROJECT_ROLES } from "@weaver/core/services/userSchemas";
import { Trash2, UserPlus } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { RouterOutputs } from "~/trpc/react";
import { useCloseOnSettle } from "../../../users/[userId]/_components/useCloseOnSettle";

type Member = RouterOutputs["adminProject"]["get"]["members"][number];
type ProjectRoleName = Member["role"];
type Candidate = RouterOutputs["user"]["list"]["users"][number];

export function addableCandidates<T extends { id: string }>(
  candidates: T[],
  members: { userId: string }[],
  callerId: string | undefined,
): T[] {
  const memberIds = new Set(members.map((m) => m.userId));
  return candidates.filter(
    (user) => !memberIds.has(user.id) && user.id !== callerId,
  );
}

/** A selection that is no longer offered must not be submittable. */
export function effectiveSelection(
  addUserId: string,
  available: { id: string }[],
): string {
  return available.some((user) => user.id === addUserId) ? addUserId : "";
}

export function candidateLabel(user: {
  name: string;
  email: string;
  active?: boolean;
}): string {
  const label = `${user.name} (${user.email})`;
  return user.active === false ? `${label} — deactivated` : label;
}

/** Presentational — takes plain props and callbacks so it renders without tRPC. */
export function ProjectMembersCard({
  projectName,
  members,
  callerId,
  candidates,
  userSearch,
  onUserSearchChange,
  onSetMembership,
  pending,
}: {
  projectName: string;
  members: Member[];
  callerId: string | undefined;
  candidates: Candidate[];
  userSearch: string;
  onUserSearchChange: (value: string) => void;
  onSetMembership: (userId: string, role: ProjectRoleName | null) => void;
  pending: boolean;
}) {
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  useCloseOnSettle(pending, () => setRemoveTarget(null));
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<ProjectRoleName>("Viewer");

  const memberIds = new Set(members.map((m) => m.userId));
  const available = addableCandidates(candidates, members, callerId);
  const selectedUserId = effectiveSelection(addUserId, available);
  const callerIsMember = callerId !== undefined && memberIds.has(callerId);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Who belongs to {projectName} and their role. Changes take effect
            immediately and are recorded in the diagnostic log.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {members.length === 0 ? (
            <p className="text-text-3 m-0 text-[13px]">No members.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const isSelf = member.userId === callerId;
                  return (
                    <TableRow key={member.userId}>
                      <TableCell className="text-text text-[13px] font-medium">
                        <div className="flex items-center gap-1.5">
                          {member.name}
                          {member.active ? null : (
                            <Badge variant="destructive">Deactivated</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-text-2 text-[13px]">
                        {member.email}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={member.role}
                          disabled={isSelf || pending}
                          onValueChange={(value) =>
                            onSetMembership(
                              member.userId,
                              value as ProjectRoleName,
                            )
                          }
                        >
                          <SelectTrigger size="sm" className="w-32">
                            <SelectValue>{member.role}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {PROJECT_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {role}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {isSelf ? null : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={pending}
                            aria-label={`Remove ${member.name}`}
                            onClick={() => setRemoveTarget(member)}
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

          <div className="border-line flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-member-search">Find user</Label>
              <Input
                id="add-member-search"
                type="search"
                placeholder="Name or email"
                value={userSearch}
                disabled={pending}
                onChange={(event) => onUserSearchChange(event.target.value)}
                className="w-48"
              />
            </div>
            <Select
              value={selectedUserId}
              disabled={pending || available.length === 0}
              onValueChange={setAddUserId}
            >
              <SelectTrigger
                aria-label="User to add"
                size="sm"
                className="w-56"
              >
                <SelectValue placeholder="Choose a user" />
              </SelectTrigger>
              <SelectContent>
                {available.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {candidateLabel(user)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={addRole}
              disabled={pending}
              onValueChange={(value) => setAddRole(value as ProjectRoleName)}
            >
              <SelectTrigger aria-label="Role" size="sm" className="w-32">
                <SelectValue>{addRole}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PROJECT_ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || selectedUserId.length === 0}
              onClick={() => {
                onSetMembership(selectedUserId, addRole);
              }}
            >
              <UserPlus data-icon="inline-start" />
              Add
            </Button>
          </div>
          <p className="text-text-3 m-0 text-[12px]">
            {callerIsMember
              ? "You can't change your own project membership."
              : "You can't add yourself; ask one of this project's Owners or Maintainers, or another administrator."}
          </p>
        </CardContent>
      </Card>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (pending) return;
          if (!nextOpen) setRemoveTarget(null);
        }}
      >
        <DialogContent aria-busy={pending || undefined}>
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Remove {removeTarget?.name} from {projectName}? They will lose
              access to it immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || removeTarget === null}
              onClick={() => {
                if (removeTarget) onSetMembership(removeTarget.userId, null);
              }}
            >
              {pending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
