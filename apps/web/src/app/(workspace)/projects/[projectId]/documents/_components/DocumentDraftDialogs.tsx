"use client";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

export function DocumentDraftDialogs({
  discardOpen,
  onDiscardOpenChange,
  onDiscard,
  conflictOpen,
  onConflictOpenChange,
  conflictError,
  busy,
  activity,
  canEdit,
  onOverwrite,
  onReload,
}: {
  discardOpen: boolean;
  onDiscardOpenChange: (open: boolean) => void;
  onDiscard: () => void;
  conflictOpen: boolean;
  onConflictOpenChange: (open: boolean) => void;
  conflictError?: string;
  busy: boolean;
  activity: "save" | "reload" | "overwrite" | null;
  canEdit: boolean;
  onOverwrite: () => void;
  onReload: () => void;
}) {
  return (
    <>
      <Dialog
        open={discardOpen}
        onOpenChange={(open) => {
          if (!busy) onDiscardOpenChange(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your title and document will return to the saved version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onDiscardOpenChange(false)}
            >
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onDiscard}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={conflictOpen}
        onOpenChange={(open) => {
          if (!busy) onConflictOpenChange(open);
        }}
      >
        <DialogContent showCloseButton={false} aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>This document changed elsewhere</DialogTitle>
            <DialogDescription>
              Someone else saved this document after you opened it. Your changes
              are still here. Reloading discards your changes; overwriting
              replaces their version with yours.
            </DialogDescription>
          </DialogHeader>
          {conflictError ? (
            <p role="alert" className="text-danger">
              {conflictError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onConflictOpenChange(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canEdit}
              onClick={onOverwrite}
            >
              {activity === "overwrite"
                ? "Overwriting…"
                : "Overwrite with my version"}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={onReload}>
              {activity === "reload" ? "Reloading…" : "Reload latest"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
