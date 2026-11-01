"use client";

import { Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { FolderPicker } from "../documents/_components/FolderPicker";
import { TableFolderPicker } from "../tables/_components/TableFolderPicker";

type SendToRemoteDialogProps = {
  kind: "document" | "table";
  projectId: string;
  itemId: string;
  itemTitle: string;
  dirty?: boolean;
  triggerClassName?: string;
  /** Icon-only trigger for narrow toolbars; same behavior, no visible label. */
  compact?: boolean;
  /** Opened by a menu item instead of its own trigger; closing returns focus to `returnFocusRef`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocusRef?: { current: HTMLElement | null };
};

function isReconnectError(error: { data?: unknown } | null | undefined) {
  const data = error?.data as { field?: string } | undefined;
  return data?.field === "remoteInstanceId";
}

export function SendToRemoteDialog({
  kind,
  projectId,
  itemId,
  itemTitle,
  dirty = false,
  triggerClassName,
  compact = false,
  open: controlledOpen,
  onOpenChange,
  returnFocusRef,
}: SendToRemoteDialogProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = onOpenChange !== undefined;
  const open = controlled ? (controlledOpen ?? false) : ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [remoteInstanceId, setRemoteInstanceId] = useState<string>();
  const [targetProjectId, setTargetProjectId] = useState<string>();
  const [targetFolderPath, setTargetFolderPath] = useState<string[]>([]);

  const remotesQuery = api.remoteInstance.listForUser.useQuery();
  const remotes = remotesQuery.data ?? [];

  const targetsQuery = api.remoteInstance.targets.useQuery(
    { remoteInstanceId: remoteInstanceId ?? "" },
    { enabled: Boolean(remoteInstanceId) },
  );
  const foldersQuery = api.remoteInstance.targetFolders.useQuery(
    {
      remoteInstanceId: remoteInstanceId ?? "",
      projectId: targetProjectId ?? "",
    },
    { enabled: Boolean(remoteInstanceId) && Boolean(targetProjectId) },
  );

  const selectedRemote = remotes.find(
    (remote) => remote.id === remoteInstanceId,
  );

  function reset() {
    setRemoteInstanceId(undefined);
    setTargetProjectId(undefined);
    setTargetFolderPath([]);
    sendDocument.reset();
    sendTable.reset();
  }

  function handleSent(result: { id: string; path: string; url: string }) {
    toast.success(`Sent to ${selectedRemote?.name ?? "the remote"}`, {
      action: {
        label: "Open there",
        onClick: () => window.open(result.url, "_blank", "noopener"),
      },
    });
    setOpen(false);
    reset();
  }

  const sendDocument = api.remoteInstance.sendDocument.useMutation({
    onSuccess: handleSent,
    onError: (err) => toast.error(err.message),
  });
  const sendTable = api.remoteInstance.sendTable.useMutation({
    onSuccess: handleSent,
    onError: (err) => toast.error(err.message),
  });
  const sendMutation = kind === "document" ? sendDocument : sendTable;

  if (remotes.length === 0) return null;

  const folders =
    kind === "document"
      ? foldersQuery.data?.documents
      : foldersQuery.data?.tables;

  function handleSend() {
    if (!remoteInstanceId || !targetProjectId) return;
    const common = {
      remoteInstanceId,
      projectId,
      targetProjectId,
      targetFolderPath,
    };
    if (kind === "document")
      sendDocument.mutate({ ...common, documentId: itemId });
    else sendTable.mutate({ ...common, tableId: itemId });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (sendMutation.isPending) return;
        if (!nextOpen) reset();
        setOpen(nextOpen);
      }}
    >
      {controlled ? null : (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={compact ? "icon-sm" : undefined}
            className={cn(
              !compact && !triggerClassName && "min-h-11",
              triggerClassName,
            )}
            aria-label={compact ? "Send to another Weaver…" : undefined}
            title={dirty ? "Sends the saved version" : undefined}
          >
            <Send data-icon={compact ? undefined : "inline-start"} />
            {compact ? null : "Send to another Weaver…"}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        aria-busy={sendMutation.isPending || undefined}
        onCloseAutoFocus={
          returnFocusRef
            ? (event) => {
                event.preventDefault();
                focusDialogTarget(returnFocusRef.current);
              }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Send to another Weaver</DialogTitle>
          <DialogDescription>
            {dirty
              ? `Sends the saved version of "${itemTitle}" to a project and folder you choose on another Weaver instance.`
              : `Sends "${itemTitle}" to a project and folder you choose on another Weaver instance.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="send-remote-select">Remote instance</Label>
            <Select
              value={remoteInstanceId}
              disabled={sendMutation.isPending}
              onValueChange={(value) => {
                setRemoteInstanceId(value);
                setTargetProjectId(undefined);
                setTargetFolderPath([]);
              }}
            >
              <SelectTrigger id="send-remote-select">
                <SelectValue placeholder="Select an instance" />
              </SelectTrigger>
              <SelectContent>
                {remotes.map((remote) => (
                  <SelectItem
                    key={remote.id}
                    value={remote.id}
                    disabled={!remote.connection}
                  >
                    {remote.name}
                    {!remote.connection ? " (connect first)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-text-3 text-[12px]">
              Need to connect an instance first?{" "}
              <Link href="/account/remote-instances" className="underline">
                Account › Remote instances
              </Link>
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="send-project-select">Project</Label>
            <Select
              value={targetProjectId}
              disabled={
                !remoteInstanceId ||
                targetsQuery.isLoading ||
                sendMutation.isPending
              }
              onValueChange={(value) => {
                setTargetProjectId(value);
                setTargetFolderPath([]);
              }}
            >
              <SelectTrigger id="send-project-select">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {(targetsQuery.data?.projects ?? []).map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetsQuery.error ? (
              isReconnectError(targetsQuery.error) ? (
                <p
                  role="alert"
                  className="border-danger/30 bg-danger/10 text-danger rounded border px-3 py-2 text-[12px]"
                >
                  {targetsQuery.error.message}{" "}
                  <Link href="/account/remote-instances" className="underline">
                    Connect
                  </Link>
                </p>
              ) : (
                <p role="alert" className="text-danger text-[12px]">
                  {targetsQuery.error.message}
                </p>
              )
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Folder</Label>
            {kind === "document" ? (
              <FolderPicker
                folders={folders?.folders ?? []}
                folderNames={folders?.folderNames}
                value={targetFolderPath}
                onValueChange={setTargetFolderPath}
                disabled={!targetProjectId || sendMutation.isPending}
              />
            ) : (
              <TableFolderPicker
                id="send-folder-select"
                label="Folder"
                folders={folders?.folders ?? []}
                folderNames={folders?.folderNames}
                value={targetFolderPath}
                onValueChange={setTargetFolderPath}
                disabled={!targetProjectId || sendMutation.isPending}
              />
            )}
            {foldersQuery.error ? (
              <p role="alert" className="text-danger text-[12px]">
                {foldersQuery.error.message}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={sendMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={
              !remoteInstanceId || !targetProjectId || sendMutation.isPending
            }
            onClick={handleSend}
          >
            {sendMutation.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
