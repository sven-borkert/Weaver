"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

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
import { api } from "~/trpc/react";

export function DeleteProjectDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const deleteProject = api.project.delete.useMutation({
    onSuccess: () => {
      toast.success("Project deleted");
      void utils.account.landingProject.invalidate();
      void utils.project.list.invalidate();
      router.push("/");
    },
    onError: (err) => {
      toast.error(err.message || "Could not delete the project");
    },
  });

  const confirmed = confirmName === projectName;

  return (
    <Card className="border-danger-border">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Irreversible actions for this project.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <p className="text-text-2 m-0 max-w-[420px] text-[13px]">
          Deleting this project removes it for all members. Documents, tables
          and the knowledge graph become inaccessible.
        </p>
        <Button
          variant="destructive"
          onClick={() => {
            setConfirmName("");
            setOpen(true);
          }}
        >
          Delete project
        </Button>
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (deleteProject.isPending) return;
          setOpen(nextOpen);
          if (!nextOpen) setConfirmName("");
        }}
      >
        <DialogContent
          aria-busy={deleteProject.isPending || undefined}
          showCloseButton={!deleteProject.isPending}
        >
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              This will delete <strong>{projectName}</strong> for all members.
              Type the project name to confirm.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmed && !deleteProject.isPending)
                deleteProject.mutate({ projectId });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-project-confirm">Project name</Label>
              <Input
                id="delete-project-confirm"
                autoFocus
                value={confirmName}
                placeholder={projectName}
                onChange={(event) => setConfirmName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={deleteProject.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={!confirmed || deleteProject.isPending}
                type="submit"
              >
                {deleteProject.isPending ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
