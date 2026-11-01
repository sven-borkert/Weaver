"use client";

import { ChevronRight, Wrench } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import type { ToolRow } from "~/lib/assistant/liveMessage";
import { cn } from "~/lib/utils";

const LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  list_projects: () => "Listed projects",
  list_documents: () => "Listed documents",
  read_document: () => "Read a document",
  navigate_document: (input) =>
    input.mode === "outline"
      ? "Read a document outline"
      : input.mode === "section"
        ? "Read a document section"
        : "Searched within a document",
  content_history: (input) =>
    input.mode === "diff"
      ? "Compared two revisions"
      : input.mode === "deleted"
        ? "Listed deleted documents and tables"
        : "Read version history",
  list_tables: () => "Listed tables",
  get_table: () => "Read a table",
  query_table_rows: () => "Queried table rows",
  list_table_columns: () => "Listed table columns",
  list_table_column_options: () => "Listed column options",
  read_table_cell: () => "Read a table cell",
  search_knowledge: (input) =>
    typeof input.query === "string"
      ? `Searched knowledge for “${input.query}”`
      : "Searched knowledge",
  search_entities: () => "Searched graph entities",
  entity_neighborhood: () => "Explored a graph neighbourhood",
  entity_detail: () => "Read a graph entity",
  resolve_citation: () => "Checked a citation",
  propose_document_create: () => "Proposed a new document",
  propose_document_edit: () => "Proposed a document edit",
  propose_document_patch: () => "Proposed a precise document edit",
  propose_table_create: () => "Proposed a new table",
  propose_table_schema_change: () => "Proposed a table schema change",
  propose_table_rows: () => "Proposed table row changes",
  propose_table_change: () => "Proposed a table change",
  propose_content_restore: (input) =>
    input.mode === "deleted"
      ? `Proposed recovering a deleted ${input.resourceType === "table" ? "table" : "document"}`
      : "Proposed restoring an earlier version",
};

export function toolActivityLabel(row: ToolRow): string {
  if (row.callId)
    return `External tool: ${row.connectionName ? `${row.connectionName} / ` : ""}${row.toolName}`;
  const input =
    row.input && typeof row.input === "object"
      ? (row.input as Record<string, unknown>)
      : {};
  return LABELS[row.toolName]?.(input) ?? `Used ${row.toolName}`;
}

export function ToolActivity({ tools }: { tools: ToolRow[] }) {
  if (tools.length === 0) return null;
  return (
    <Collapsible className="my-2">
      <CollapsibleTrigger className="text-text-2 hover:text-text group flex items-center gap-1 text-[12px]">
        <ChevronRight
          className="size-3 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <Wrench className="size-3" aria-hidden="true" />
        Used {tools.length} tool{tools.length === 1 ? "" : "s"}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        <ul className="border-line mt-1 ml-1 border-l pl-3 text-[12px]">
          {tools.map((row) => (
            <li
              key={row.toolCallId}
              className={cn(
                "py-0.5",
                row.ok === false ? "text-danger" : "text-text-2",
              )}
            >
              {toolActivityLabel(row)}
              {row.externalStatus ? (
                <span className="text-text-muted">
                  {" "}
                  ·{" "}
                  {row.externalStatus === "pending"
                    ? "waiting for approval"
                    : row.externalStatus === "unknown"
                      ? "outcome unknown — check the external service before trying again"
                      : row.externalStatus === "dispatched"
                        ? "running"
                        : row.externalStatus}
                </span>
              ) : null}
              {row.ok === null && !row.externalStatus ? (
                <span className="text-text-muted"> · running</span>
              ) : null}
              {row.summary ? <span> · {row.summary}</span> : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
