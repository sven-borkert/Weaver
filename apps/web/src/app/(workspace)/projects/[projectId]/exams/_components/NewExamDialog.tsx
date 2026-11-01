"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
export function NewExamDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(30);
  const router = useRouter();
  const utils = api.useUtils();
  const create = api.exam.create.useMutation({
    onSuccess: async (e) => {
      await utils.exam.list.invalidate({ projectId });
      router.push(`/projects/${projectId}/exams/${e.id}`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!create.isPending) {
          setOpen(v);
          if (!v) {
            setTitle("");
            setMinutes(30);
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>New exam</Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={create.isPending}
        showCloseButton={!create.isPending}
      >
        <DialogHeader>
          <DialogTitle>New exam</DialogTitle>
          <DialogDescription>
            Create a draft, then add questions.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              projectId,
              title,
              timeLimitMinutes: minutes,
              status: "draft",
              questions: [],
            });
          }}
        >
          <fieldset disabled={create.isPending} className="space-y-3">
            <label htmlFor="new-exam-title">Title</label>
            <Input
              id="new-exam-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <label htmlFor="new-exam-time">Time limit (minutes)</label>
            <Input
              id="new-exam-time"
              type="number"
              min={1}
              max={1440}
              required
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Create exam</Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
