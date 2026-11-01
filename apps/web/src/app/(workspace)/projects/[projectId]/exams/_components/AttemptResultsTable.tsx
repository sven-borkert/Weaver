import type { TraineeAttemptSummary } from "@weaver/core/services/exams";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "~/components/ui/table";
import { DeleteAttemptButton } from "./DeleteAttemptButton";
import { ATTEMPT_STATUS_LABELS, scoreLabel } from "./examPresentation";
export type ResultRow = TraineeAttemptSummary & {
  examTitle: string;
  traineeName?: string;
};
export function AttemptResultsTable({
  projectId,
  attempts,
  trainer,
}: {
  projectId: string;
  attempts: ResultRow[];
  trainer: boolean;
}) {
  return (
    <Table
      aria-label={trainer ? "Exam attempts and grades" : "Your exam results"}
    >
      <TableHeader>
        <TableRow>
          <TableHead>Exam</TableHead>
          {trainer ? <TableHead>Trainee</TableHead> : null}
          <TableHead>Attempt</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Submitted</TableHead>
          <TableHead>Score</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attempts.map((a) => {
          const label =
            a.status === "released"
              ? "View result"
              : trainer
                ? a.status === "in_review"
                  ? "Review grade"
                  : "Review attempt"
                : "Open attempt";
          return (
            <TableRow key={a.id}>
              <TableCell className="font-medium">{a.examTitle}</TableCell>
              {trainer ? <TableCell>{a.traineeName}</TableCell> : null}
              <TableCell>{a.attemptNumber}</TableCell>
              <TableCell>
                {trainer && a.status === "in_review"
                  ? "Awaiting your review"
                  : ATTEMPT_STATUS_LABELS[a.status]}
              </TableCell>
              <TableCell>
                {a.submittedAt ? (
                  <ClientDateTime value={new Date(a.submittedAt)} />
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                {(trainer || a.status === "released") && a.totalScore !== null
                  ? scoreLabel(a)
                  : "—"}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/projects/${projectId}/exams/attempts/${a.id}`}
                      aria-label={`${label}: ${a.examTitle}, attempt ${a.attemptNumber}${trainer ? `, ${a.traineeName}` : ""}`}
                    >
                      {label}
                      <ArrowUpRight aria-hidden="true" />
                    </Link>
                  </Button>
                  <DeleteAttemptButton
                    attemptId={a.id}
                    examTitle={a.examTitle}
                    attemptNumber={a.attemptNumber}
                  />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
        {!attempts.length ? (
          <TableRow>
            <TableCell
              colSpan={trainer ? 7 : 6}
              className="text-text-3 py-8 text-center"
            >
              No results yet.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
