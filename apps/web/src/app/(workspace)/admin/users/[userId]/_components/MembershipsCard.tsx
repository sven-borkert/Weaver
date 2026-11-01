"use client";

import { PROJECT_ROLES } from "@weaver/core/services/userSchemas";
import { Trash2, UserPlus } from "lucide-react";
import { useState } from "react";

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
import { useCloseOnSettle } from "./useCloseOnSettle";

type Membership = RouterOutputs["user"]["get"]["memberships"][number];
type ProjectRoleName = Membership["role"];
type ProjectOption = RouterOutputs["user"]["listProjects"][number];

/** Presentational — takes plain props and callbacks so it renders without tRPC. */
export function MembershipsCard({
  memberships,
  projects,
  isSelf,
  onSetMembership,
  pending,
}: {
  memberships: Membership[];
  projects: ProjectOption[];
  isSelf: boolean;
  onSetMembership: (projectId: string, role: ProjectRoleName | null) => void;
  pending: boolean;
}) {
  const [removeTarget, setRemoveTarget] = useState<Membership | null>(null);
  useCloseOnSettle(pending, () => setRemoveTarget(null));

  const memberProjectIds = new Set(memberships.map((m) => m.projectId));
  const availableProjects = projects.filter(
    (project) => !memberProjectIds.has(project.id),
  );
  const [addProjectId, setAddProjectId] = useState("");
  const [addRole, setAddRole] = useState<ProjectRoleName>("Viewer");

  const canAdd = !isSelf && addProjectId.length > 0 && !pending;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Project memberships</CardTitle>
          <CardDescription>
            Projects this user belongs to and their role on each.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {memberships.length === 0 ? (
            <p className="text-text-3 m-0 text-[13px]">
              No project memberships.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberships.map((membership) => (
                  <TableRow key={membership.projectId}>
                    <TableCell className="text-text text-[13px] font-medium">
                      {membership.projectName}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={membership.role}
                        disabled={isSelf || pending}
                        onValueChange={(value) =>
                          onSetMembership(
                            membership.projectId,
                            value as ProjectRoleName,
                          )
                        }
                      >
                        <SelectTrigger size="sm" className="w-32">
                          <SelectValue>{membership.role}</SelectValue>
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={isSelf || pending}
                        aria-label={`Remove from ${membership.projectName}`}
                        onClick={() => setRemoveTarget(membership)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="border-line flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-membership-project">Add to project</Label>
              <Select
                value={addProjectId}
                disabled={isSelf || pending || availableProjects.length === 0}
                onValueChange={setAddProjectId}
              >
                <SelectTrigger
                  id="add-membership-project"
                  size="sm"
                  className="w-48"
                >
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {availableProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Select
              value={addRole}
              disabled={isSelf || pending}
              onValueChange={(value) => setAddRole(value as ProjectRoleName)}
            >
              <SelectTrigger size="sm" className="w-32">
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
              disabled={!canAdd}
              onClick={() => {
                onSetMembership(addProjectId, addRole);
                setAddProjectId("");
              }}
            >
              <UserPlus data-icon="inline-start" />
              Add
            </Button>
          </div>
          {isSelf ? (
            <p className="text-text-3 m-0 text-[12px]">
              You cannot change your own project memberships.
            </p>
          ) : availableProjects.length === 0 && projects.length > 0 ? (
            <p className="text-text-3 m-0 text-[12px]">
              Already a member of every project you can see.
            </p>
          ) : null}
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
            <DialogTitle>Remove from project</DialogTitle>
            <DialogDescription>
              Remove this user from {removeTarget?.projectName}? They will lose
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
                if (removeTarget) onSetMembership(removeTarget.projectId, null);
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
