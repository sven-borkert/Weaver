"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
export function StartExamDialog({
  projectId,
  exam,
  label = "Start",
}: {
  projectId: string;
  exam: { id: string; title: string; timeLimitMinutes: number };
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const utils = api.useUtils();
  const start = api.exam.start.useMutation({
    onSuccess: async (a) => {
      await utils.exam.listAvailable.invalidate({ projectId });
      router.push(`/projects/${projectId}/exams/attempts/${a.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!start.isPending) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button>{label}</Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={start.isPending}
        showCloseButton={!start.isPending}
      >
        <DialogHeader>
          <DialogTitle>Start {exam.title}?</DialogTitle>
          <DialogDescription>
            You have {exam.timeLimitMinutes} minutes. The clock keeps running
            when you leave this page.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={start.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={start.isPending}
            onClick={() => start.mutate({ examId: exam.id })}
          >
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
