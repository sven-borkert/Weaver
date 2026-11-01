"use client";

import { type RefObject, useRef, useState } from "react";
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
import { focusDialogTarget } from "~/lib/dialog-focus";
import { api } from "~/trpc/react";

export function DisconnectRemoteDialog({
  remoteInstanceId,
  name,
  fallbackFocusRef,
}: {
  remoteInstanceId: string;
  name: string;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreToFallbackRef = useRef(false);
  const disconnect = api.remoteInstance.disconnect.useMutation({
    onSuccess: () => {
      toast.success(`Disconnected from ${name}`);
      restoreToFallbackRef.current = true;
      setOpen(false);
      void utils.remoteInstance.listForUser.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not disconnect");
      void utils.remoteInstance.listForUser.invalidate();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (disconnect.isPending) return;
        if (nextOpen) restoreToFallbackRef.current = false;
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm">
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={disconnect.isPending || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = restoreToFallbackRef.current
            ? null
            : triggerRef.current;
          restoreToFallbackRef.current = false;
          focusDialogTarget(target, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Disconnect remote instance</DialogTitle>
          <DialogDescription>
            Disconnect from {name}? Sending to it will require connecting again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={disconnect.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate({ remoteInstanceId })}
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
