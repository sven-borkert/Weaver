import type { TableColumn, TableRow } from "@weaver/core/tables/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow as Tr,
} from "~/components/ui/table";
import { formatDiffCellValue } from "~/lib/tables/presentation";

/**
 * `prepare()` stores only `MAX_SAMPLE_ROWS` rows plus the true `rowCount`, so
 * this says what it is showing rather than implying the table is that small.
 */
export function TableCreatePreview({
  columns,
  rowCount,
  sampleRows,
  truncated,
}: {
  columns: readonly TableColumn[];
  rowCount: number;
  sampleRows: readonly TableRow[];
  truncated: boolean;
}) {
  const sampled = sampleRows.length < rowCount;

  return (
    <div className="border-line bg-surface overflow-hidden rounded-md border">
      <div className="scrollarea max-h-80 overflow-auto">
        <Table className="text-[12px]">
          <TableHeader>
            <Tr>
              {columns.map((column) => (
                <TableHead key={column.id} className="h-7 px-2">
                  {column.name}{" "}
                  <span className="text-text-muted">({column.type})</span>
                </TableHead>
              ))}
            </Tr>
          </TableHeader>
          <TableBody>
            {sampleRows.map((row) => (
              <Tr key={row.id}>
                {columns.map((column) => {
                  const value = row.cells[column.id];
                  return (
                    <TableCell key={column.id} className="px-2 py-1">
                      {value === undefined
                        ? ""
                        : formatDiffCellValue(value, column)}
                    </TableCell>
                  );
                })}
              </Tr>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-text-muted border-line m-0 border-t px-2 py-1 text-[11px]">
        {sampled
          ? `Showing ${sampleRows.length.toLocaleString("en-US")} of ${rowCount.toLocaleString("en-US")} rows`
          : `${rowCount.toLocaleString("en-US")} row${rowCount === 1 ? "" : "s"}`}
        {truncated ? " · preview shortened to fit" : ""}
      </p>
    </div>
  );
}
