"use client";
import { useState, useRef } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api, type RouterOutputs } from "~/trpc/react";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "~/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { ExamQueryState } from "./ExamQueryState";
import { EXAM_STATUS_LABELS } from "./examPresentation";
import { NewExamDialog } from "./NewExamDialog";
type Exam = RouterOutputs["exam"]["list"]["items"][number];
export function TrainerExamList({ projectId }: { projectId: string }) {
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const q = api.exam.list.useQuery({
    projectId,
    cursor: cursors.at(-1),
    limit: 50,
  });
  const page = dataUnlessAccessError(q.data, q.error);
  const exams = page?.items;
  const utils = api.useUtils();
  const [target, setTarget] = useState<Exam | null>(null);
  const invalidate = () =>
    Promise.all([
      utils.exam.list.invalidate(),
      utils.exam.listAttempts.invalidate(),
      utils.exam.listAvailable.invalidate(),
    ]);
  const update = api.exam.update.useMutation({
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const remove = api.exam.delete.useMutation({
    onSuccess: async () => {
      await invalidate();
      setTarget(null);
      toast.success("Exam deleted");
    },
    onError: (e) => toast.error(e.message),
  });
  if (!exams)
    return (
      <ExamQueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.refetch()}
      />
    );
  return (
    <section ref={sectionRef} tabIndex={-1} className="space-y-3">
      <NewExamDialog projectId={projectId} />
      {q.error ? (
        <ExamQueryState error={q.error} retry={() => void q.refetch()} />
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {[
              "Title",
              "Status",
              "Questions",
              "Time limit",
              "Waiting",
              "In review",
              "Released",
              "Updated",
              "Actions",
            ].map((s) => (
              <TableHead key={s}>{s}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {exams.map((e) => {
            const hasAttempts = Object.values(e.attemptCounts).some(
              (n) => n > 0,
            );
            return (
              <TableRow key={e.id}>
                <TableCell>
                  <Link href={`/projects/${projectId}/exams/${e.id}`}>
                    {e.title}
                  </Link>
                </TableCell>
                <TableCell>{EXAM_STATUS_LABELS[e.status]}</TableCell>
                <TableCell>{e.questionCount}</TableCell>
                <TableCell>{e.timeLimitMinutes} min</TableCell>
                <TableCell>{e.attemptCounts.waiting}</TableCell>
                <TableCell>{e.attemptCounts.inReview}</TableCell>
                <TableCell>{e.attemptCounts.released}</TableCell>
                <TableCell>{new Date(e.updatedAt).toLocaleString()}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        aria-label={`Actions for ${e.title}`}
                        onClick={(event) => {
                          actionRef.current = event.currentTarget;
                        }}
                      >
                        Actions
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem asChild>
                        <Link href={`/projects/${projectId}/exams/${e.id}`}>
                          Edit
                        </Link>
                      </DropdownMenuItem>
                      {e.status !== "published" ? (
                        <DropdownMenuItem
                          disabled={update.isPending || !e.questionCount}
                          onSelect={() =>
                            update.mutate({
                              examId: e.id,
                              expectedRevision: e.revision,
                              status: "published",
                            })
                          }
                        >
                          {e.status === "archived" ? "Re-open" : "Publish"}
                        </DropdownMenuItem>
                      ) : null}
                      {e.status !== "archived" ? (
                        <DropdownMenuItem
                          disabled={update.isPending}
                          onSelect={() =>
                            update.mutate({
                              examId: e.id,
                              expectedRevision: e.revision,
                              status: "archived",
                            })
                          }
                        >
                          Archive
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        disabled={hasAttempts}
                        title={hasAttempts ? "Archive instead" : undefined}
                        onSelect={() => setTarget(e)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!exams.length ? <p>No exams on this page.</p> : null}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={cursors.length === 1 || q.isFetching}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          Previous
        </Button>
        <span>Page {cursors.length}</span>
        <Button
          variant="outline"
          disabled={!page?.nextCursor || q.isFetching}
          onClick={() => {
            if (page?.nextCursor)
              setCursors((value) => [...value, page.nextCursor!]);
          }}
        >
          Next
        </Button>
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(v) => {
          if (!remove.isPending && !v) setTarget(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(actionRef.current, sectionRef.current);
          }}
          aria-busy={remove.isPending}
          showCloseButton={!remove.isPending}
        >
          <DialogHeader>
            <DialogTitle>Delete exam?</DialogTitle>
            <DialogDescription>
              Delete {target?.title}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (target) remove.mutate({ examId: target.id });
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
