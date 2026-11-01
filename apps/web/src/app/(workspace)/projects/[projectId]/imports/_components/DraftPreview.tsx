"use client";

import { useMemo } from "react";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import type { DraftDetail } from "@weaver/core/services/ingestion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { renderDocumentContent } from "~/lib/editor/render";

export function DraftPreview({ draft }: { draft: DraftDetail }) {
  const content = useMemo(
    () =>
      draft.targetKind === "document" && draft.markdown !== null
        ? renderDocumentContent(parseDocumentBody(draft.markdown))
        : null,
    [draft.markdown, draft.targetKind],
  );
  if (draft.targetKind === "document") {
    return (
      <div className="document-prose text-text text-[14px] leading-relaxed">
        <div>{content}</div>
      </div>
    );
  }
  if (!draft.table)
    return (
      <p role="alert" className="text-danger m-0 text-sm">
        The table draft could not be read.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-text-3 m-0 text-xs">
        Showing {draft.table.sampleRows.length} of {draft.table.rowCount} rows.
      </p>
      <div className="border-line overflow-x-auto rounded-[10px] border">
        <Table>
          <TableHeader>
            <TableRow>
              {draft.table.columns.map((column) => (
                <TableHead key={column.name}>{column.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.table.sampleRows.map((row, index) => (
              <TableRow key={index}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex} className="max-w-64 truncate">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
