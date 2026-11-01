"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";

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
import { tableDialogValueForAccess } from "./table-polish";

export function RestoreTableVersionDialog({
  sha,
  canEdit,
  editAccessToken,
  pending,
  error,
  onRestore,
}: {
  sha: string;
  canEdit: boolean;
  editAccessToken: object;
  pending: boolean;
  error?: string;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [openAccessToken, setOpenAccessToken] = useState<object>();
  const visibleOpen = Boolean(
    tableDialogValueForAccess(
      open && openAccessToken
        ? { accessToken: openAccessToken, value: true }
        : undefined,
      canEdit,
      editAccessToken,
    ),
  );

  if (!canEdit) return null;

  return (
    <Dialog
      open={visibleOpen}
      onOpenChange={(nextOpen) => {
        if (!pending) {
          if (nextOpen) setOpenAccessToken(editAccessToken);
          setOpen(nextOpen);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
          Restore this version
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!pending} aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>Restore this table version?</DialogTitle>
          <DialogDescription>
            Restoring version <strong>{sha.slice(0, 7)}</strong> creates a new
            version. The current version and all existing append-only history
            remain available.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-danger m-0 text-[12px]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={pending}
            aria-busy={pending}
            onClick={onRestore}
          >
            {pending ? "Restoring…" : "Restore version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
