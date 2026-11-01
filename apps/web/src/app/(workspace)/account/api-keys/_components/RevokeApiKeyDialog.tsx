"use client";

import { Trash2 } from "lucide-react";
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

export function RevokeApiKeyDialog({
  keyId,
  keyName,
  fallbackFocusRef,
}: {
  keyId: string;
  keyName: string;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreToFallbackRef = useRef(false);
  const revoke = api.apiKey.revoke.useMutation({
    onSuccess: () => {
      toast.success("API key revoked");
      restoreToFallbackRef.current = true;
      setOpen(false);
      void utils.apiKey.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not revoke the API key");
      void utils.apiKey.list.invalidate();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (revoke.isPending) return;
        if (nextOpen) restoreToFallbackRef.current = false;
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          aria-label={`Revoke ${keyName}`}
        >
          <Trash2 />
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={revoke.isPending || undefined}
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
          <DialogTitle>Revoke API key</DialogTitle>
          <DialogDescription>
            Revoke “{keyName}”? Tools using it lose access immediately. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={revoke.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ keyId })}
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
