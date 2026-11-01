import Link from "next/link";
import { documentVersionHref } from "~/lib/documents/section-navigation";
import { readExternalInputSummaries } from "~/lib/tasks/externalInputs";
import { Badge } from "~/components/ui/badge";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { RouterOutputs } from "~/trpc/react";
import { RUN_STATUS_LABELS } from "./scheduleForm";

type Run = RouterOutputs["scheduledTask"]["listRuns"]["runs"][number];

const TRIGGER_LABELS = { schedule: "Scheduled", manual: "Run now" } as const;

function duration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.round(ms / 60_000)} min`;
}

function tokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return "—";
  return `${(input ?? 0).toLocaleString("en-US")} in · ${(output ?? 0).toLocaleString("en-US")} out`;
}

function statusVariant(status: Run["status"]) {
  if (status === "succeeded") return "secondary" as const;
  if (status === "failed") return "destructive" as const;
  return "outline" as const;
}

export function RunHistoryTable({ runs }: { runs: Run[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Tokens</TableHead>
          <TableHead>Output</TableHead>
          <TableHead>Details</TableHead>
          <TableHead>External inputs</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>
              <Badge variant={statusVariant(run.status)}>
                {RUN_STATUS_LABELS[run.status]}
              </Badge>
            </TableCell>
            <TableCell>{TRIGGER_LABELS[run.trigger]}</TableCell>
            <TableCell>
              <ClientDateTime value={run.startedAt ?? run.queuedAt} />
            </TableCell>
            <TableCell>{duration(run.durationMs)}</TableCell>
            <TableCell>{tokens(run.inputTokens, run.outputTokens)}</TableCell>
            <TableCell>
              {/* The run's own project and commit: the task may write elsewhere by now. */}
              {run.outputDocumentId &&
              run.outputCommitSha &&
              run.outputProjectId ? (
                <Link
                  href={documentVersionHref({
                    projectId: run.outputProjectId,
                    documentId: run.outputDocumentId,
                    versionSha: run.outputCommitSha,
                  })}
                  className="font-mono text-[12px] hover:underline"
                >
                  {run.outputCommitSha.slice(0, 7)}
                </Link>
              ) : run.outputCommitSha ? (
                <span className="font-mono text-[12px]">
                  {run.outputCommitSha.slice(0, 7)}
                </span>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-text-3 text-[12px]">
              {run.errorCode ? (
                <span>
                  <span className="font-mono">{run.errorCode}</span>
                  {run.errorMessage ? ` — ${run.errorMessage}` : ""}
                </span>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="text-text-3 text-[12px]">
              <ExternalInputRunSummary context={run.contextSummary} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ExternalInputRunSummary({ context }: { context: unknown }) {
  const inputs = readExternalInputSummaries(context);
  return inputs.length ? (
    <ul className="space-y-2">
      {inputs.map((input, index) => (
        <li key={index}>
          <span className="font-medium">{input.name}</span> ·{" "}
          {input.status === "completed" ? "Completed" : "Failed"}
          <br />
          Retrieved:{" "}
          {input.retrievedAt ? (
            <ClientDateTime value={new Date(input.retrievedAt)} />
          ) : (
            "—"
          )}
          <br />
          Truncated: {input.truncated ? "Yes" : "No"}
          {input.failure ? <p>{input.failure}</p> : null}
        </li>
      ))}
    </ul>
  ) : (
    <span>—</span>
  );
}
