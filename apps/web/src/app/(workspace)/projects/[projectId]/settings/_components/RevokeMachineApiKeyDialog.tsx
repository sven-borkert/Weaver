"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { api } from "~/trpc/react";

export function RevokeMachineApiKeyDialog({
  projectId,
  keyId,
  name,
  fingerprint,
  focusFallback,
}: {
  projectId: string;
  keyId: string;
  name: string;
  fingerprint: string;
  focusFallback: () => HTMLElement | null;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const revoke = api.projectApiKey.revoke.useMutation({
    onSuccess: async (_data, variables) => {
      toast.success(`Revoked ${name}`);
      setOpen(false);
      await utils.projectApiKey.list.invalidate({
        projectId: variables.projectId,
      });
    },
    onError: (error) => {
      toast.error(error.message || "Could not revoke the key");
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!revoke.isPending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} size="sm" variant="outline">
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={revoke.isPending}
        showCloseButton={!revoke.isPending}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current, focusFallback());
        }}
      >
        <DialogHeader>
          <DialogTitle>Revoke {name}?</DialogTitle>
          <DialogDescription>
            Scripts using the key with fingerprint {fingerprint} lose access
            immediately. Revocation cannot be undone; create a new key to
            replace it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ projectId, keyId })}
          >
            {revoke.isPending ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
