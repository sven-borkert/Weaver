"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import { RemoteInstanceDialog } from "./RemoteInstanceDialog";

type Remote = RouterOutputs["remoteInstance"]["list"][number];

const CHECK_STATUS_LABELS: Record<string, string> = {
  ok: "Reachable",
  unreachable: "Unreachable",
  not_weaver: "Not a Weaver instance",
  oauth_unavailable: "OAuth unavailable",
};

function checkStatusLabel(status: string | null): string {
  if (!status) return "Not checked yet";
  return CHECK_STATUS_LABELS[status] ?? status;
}

type DialogState<Value> = Value & { instance: number; open: boolean };

export function RemoteInstancesScreen({
  embedded = false,
}: { embedded?: boolean } = {}) {
  const Heading = embedded ? "h2" : "h1";
  const utils = api.useUtils();
  const dialogSequenceRef = useRef(0);
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const remoteDialogTriggerRef = useRef<HTMLElement | null>(null);
  const deleteDialogTriggerRef = useRef<HTMLElement | null>(null);
  const [remoteDialog, setRemoteDialog] = useState<
    DialogState<{ remote?: Remote }> | undefined
  >();
  const [deleteTarget, setDeleteTarget] = useState<Remote | null>(null);

  const nextDialogInstance = () => {
    dialogSequenceRef.current += 1;
    return dialogSequenceRef.current;
  };

  const listQuery = api.remoteInstance.list.useQuery();
  const presentation = resolveQueryPresentation(listQuery);
  const remotes = dataUnlessAccessError(listQuery.data, listQuery.error);

  const invalidate = () => void utils.remoteInstance.invalidate();

  const testRemote = api.remoteInstance.test.useMutation({
    onSuccess: (result) => {
      if (result.status === "ok") toast.success(result.summary);
      else toast.error(result.summary);
      invalidate();
    },
    onError: (err) =>
      toast.error(err.message || "Could not test the remote instance"),
  });
  const updateRemote = api.remoteInstance.update.useMutation({
    onSuccess: () => {
      invalidate();
    },
    onError: (err) =>
      toast.error(err.message || "Could not update the remote instance"),
  });
  const deleteRemote = api.remoteInstance.delete.useMutation({
    onSuccess: () => {
      toast.success("Remote instance deleted");
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not delete the remote instance");
      setDeleteTarget(null);
    },
  });

  return (
    <div
      ref={fallbackRef}
      tabIndex={-1}
      className={
        embedded ? "flex min-w-0 flex-col gap-4" : "flex flex-col gap-4 p-6"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading className="text-text m-0 text-lg leading-snug font-semibold">
            Remote instances
          </Heading>
          <p className="text-text-3 m-0 max-w-2xl text-[13px]">
            Other Weaver instances users can send documents and tables to.
            Registering one here also lets that instance&apos;s users connect to
            this one, once its administrator registers this instance in return.
          </p>
        </div>
        <Button
          size="sm"
          onClick={(event) => {
            remoteDialogTriggerRef.current = event.currentTarget;
            setRemoteDialog({ instance: nextDialogInstance(), open: true });
          }}
        >
          Add remote instance
        </Button>
      </div>

      {presentation === "loading" ? (
        <div className="flex flex-col gap-2 py-1">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : presentation === "error" ? (
        <div role="alert">
          Could not load remote instances.{" "}
          <Button
            disabled={listQuery.isFetching}
            onClick={() => void listQuery.refetch()}
          >
            {listQuery.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : (remotes ?? []).length === 0 ? (
        <p className="text-text-3 m-0 text-[13px]">
          No remote instances yet. Add one to let users send documents and
          tables to it.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last check</TableHead>
              <TableHead className="w-52">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(remotes ?? []).map((remote) => (
              <TableRow key={remote.id}>
                <TableCell>
                  <div className="text-text text-[13px] font-medium">
                    {remote.name}
                  </div>
                </TableCell>
                <TableCell className="text-text-3 text-[12px] break-all">
                  {remote.baseUrl}
                </TableCell>
                <TableCell>
                  <Badge variant={remote.enabled ? "default" : "secondary"}>
                    {remote.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </TableCell>
                <TableCell className="text-text-3 text-[12px]">
                  {remote.lastCheckedAt ? (
                    <ClientDateTime value={remote.lastCheckedAt} />
                  ) : (
                    <span>Never</span>
                  )}
                  <span className="block">
                    {checkStatusLabel(remote.checkStatus)}
                  </span>
                  {remote.checkErrorSummary ? (
                    <span className="text-text-3 block">
                      {remote.checkErrorSummary}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Test ${remote.name}`}
                      disabled={testRemote.isPending}
                      onClick={() => testRemote.mutate({ id: remote.id })}
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Edit ${remote.name}`}
                      onClick={(event) => {
                        remoteDialogTriggerRef.current = event.currentTarget;
                        setRemoteDialog({
                          instance: nextDialogInstance(),
                          open: true,
                          remote,
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`${remote.enabled ? "Disable" : "Enable"} ${remote.name}`}
                      disabled={updateRemote.isPending}
                      onClick={() =>
                        updateRemote.mutate({
                          id: remote.id,
                          expectedRevision: remote.revision,
                          patch: { enabled: !remote.enabled },
                        })
                      }
                    >
                      {remote.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label={`Delete ${remote.name}`}
                      onClick={(event) => {
                        deleteDialogTriggerRef.current = event.currentTarget;
                        setDeleteTarget(remote);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {remoteDialog ? (
        <RemoteInstanceDialog
          key={remoteDialog.instance}
          open={remoteDialog.open}
          remote={remoteDialog.remote}
          returnFocusRef={remoteDialogTriggerRef}
          fallbackFocusRef={fallbackRef}
          onOpenChange={(open) =>
            setRemoteDialog((current) =>
              current ? { ...current, open } : current,
            )
          }
        />
      ) : null}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (deleteRemote.isPending) return;
          if (!nextOpen) setDeleteTarget(null);
        }}
      >
        <DialogContent
          aria-busy={deleteRemote.isPending || undefined}
          showCloseButton={!deleteRemote.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(
              deleteDialogTriggerRef.current,
              fallbackRef.current,
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete remote instance</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.name}? Users lose their connections to it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteRemote.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteRemote.isPending || deleteTarget === null}
              onClick={() => {
                if (deleteTarget)
                  deleteRemote.mutate({
                    id: deleteTarget.id,
                    expectedRevision: deleteTarget.revision,
                  });
              }}
            >
              {deleteRemote.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
