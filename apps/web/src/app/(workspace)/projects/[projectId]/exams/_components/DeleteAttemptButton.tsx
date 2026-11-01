"use client";

import { useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { api } from "~/trpc/react";
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

function Confirmation({
  attemptId,
  examTitle,
  attemptNumber,
  close,
  triggerRef,
}: {
  attemptId: string;
  examTitle: string;
  attemptNumber: number;
  close: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const utils = api.useUtils();
  const remove = api.exam.deleteAttempt.useMutation({
    onSuccess: async () => {
      const trigger = triggerRef.current;
      const fallback = trigger?.closest("section");
      close();
      toast.success("Attempt deleted");
      await Promise.all([
        utils.exam.listAvailable.invalidate(),
        utils.exam.listAttempts.invalidate(),
        utils.exam.list.invalidate(),
        utils.exam.get.invalidate(),
        utils.exam.getAttempt.invalidate({ attemptId }),
        utils.exam.getAttemptForReview.invalidate({ attemptId }),
        utils.backgroundWork.list.invalidate(),
        utils.backgroundWork.summary.invalidate(),
      ]);
      window.requestAnimationFrame(() => {
        if (
          !trigger?.isConnected &&
          fallback?.isConnected &&
          document.activeElement === document.body
        )
          fallback.focus();
      });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <DialogContent
      aria-busy={remove.isPending}
      showCloseButton={!remove.isPending}
      onEscapeKeyDown={(event) => {
        if (remove.isPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (remove.isPending) event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>Delete attempt?</DialogTitle>
        <DialogDescription>
          Delete attempt {attemptNumber} of {examTitle}? Its answers and grades
          will be permanently removed. This cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={remove.isPending} onClick={close}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => remove.mutate({ attemptId })}
        >
          Delete attempt
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function DeleteAttemptButton({
  attemptId,
  examTitle,
  attemptNumber,
}: {
  attemptId: string;
  examTitle: string;
  attemptNumber: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          aria-label={`Delete attempt ${attemptNumber}: ${examTitle}`}
        >
          Delete
        </Button>
      </DialogTrigger>
      {open ? (
        <Confirmation
          attemptId={attemptId}
          examTitle={examTitle}
          attemptNumber={attemptNumber}
          triggerRef={triggerRef}
          close={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}
