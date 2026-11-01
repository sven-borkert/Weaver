"use client";

import {
  ArrowDown,
  ArrowUp,
  Download,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { RefObject } from "react";

import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { withBasePath } from "~/lib/basePath";
import { cn } from "~/lib/utils";
import type { RouterInputs, RouterOutputs } from "~/trpc/react";
import { formatBytes } from "../../imports/_components/upload";
import { artifactTypeLabel } from "./artifactType";
import { NotebookStatus } from "./NotebookStatus";

export type ArtifactRow = RouterOutputs["artifact"]["list"]["items"][number];
export type ArtifactSort = NonNullable<
  RouterInputs["artifact"]["list"]["sort"]
>;

export function downloadHref(projectId: string, artifactId: string): string {
  return withBasePath(
    `/api/projects/${projectId}/artifacts/${artifactId}/download`,
  );
}

/** Presentational — renders without tRPC so it can be tested with renderToStaticMarkup. */
export function ArtifactsTable({
  items,
  canEdit,
  projectId,
  focusFilename,
  sort,
  dir,
  onSort,
  onRename,
  onDelete,
  triggerRef,
}: {
  items: ArtifactRow[];
  canEdit: boolean;
  projectId: string;
  focusFilename: string | null;
  sort: ArtifactSort;
  dir: "asc" | "desc";
  onSort: (column: ArtifactSort) => void;
  onRename: (item: ArtifactRow) => void;
  onDelete: (item: ArtifactRow) => void;
  /** Records the row's action button so a dialog can hand focus back to it. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  if (items.length === 0)
    return (
      <div className="border-line bg-surface flex flex-col items-center gap-2 rounded-[10px] border border-dashed px-6 py-12 text-center">
        <div className="text-text text-[14px] font-semibold">No files yet</div>
        <p className="text-text-3 m-0 max-w-[420px] text-[13px]">
          Upload Word, Excel, PDF, JSON or any other file.
        </p>
      </div>
    );

  const sortAriaValue = (column: ArtifactSort) =>
    sort !== column ? "none" : dir === "asc" ? "ascending" : "descending";
  const sortButton = (column: ArtifactSort, label: string) => {
    const Icon = dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className="hover:text-text inline-flex items-center gap-1"
        onClick={() => onSort(column)}
      >
        {label}
        {sort === column ? (
          <Icon className="size-3.5" aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  return (
    <div className="border-line bg-surface overflow-hidden rounded-[10px] border">
      <Table aria-label="Files">
        <TableHeader>
          <TableRow>
            <TableHead aria-sort={sortAriaValue("filename")}>
              {sortButton("filename", "Name")}
            </TableHead>
            <TableHead>Type</TableHead>
            <TableHead aria-sort={sortAriaValue("byteSize")}>
              {sortButton("byteSize", "Size")}
            </TableHead>
            <TableHead>Uploaded by</TableHead>
            <TableHead aria-sort={sortAriaValue("updatedAt")}>
              {sortButton("updatedAt", "Changed")}
            </TableHead>
            <TableHead className="w-12 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow
              key={item.id}
              data-focused={item.filename === focusFilename ? "" : undefined}
              className={cn(item.filename === focusFilename && "bg-brand-bg")}
            >
              <TableCell className="w-full max-w-0 truncate font-medium">
                <a
                  href={downloadHref(projectId, item.id)}
                  download={item.filename}
                  className="text-text hover:text-brand-text truncate outline-none focus-visible:underline"
                >
                  {item.filename}
                </a>
              </TableCell>
              <TableCell className="text-text-2">
                {artifactTypeLabel(item.contentType, item.filename)}
                {item.notebook ? (
                  <NotebookStatus state={item.notebook} />
                ) : null}
              </TableCell>
              <TableCell className="text-text-2">
                {formatBytes(item.byteSize)}
              </TableCell>
              <TableCell className="text-text-2">
                {item.uploadedBy?.name ?? "—"}
              </TableCell>
              <TableCell className="text-text-2">
                <ClientDate value={item.updatedAt} />
              </TableCell>
              <TableCell className="text-right">
                {canEdit ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${item.filename}`}
                        onClick={(event) => {
                          if (triggerRef)
                            triggerRef.current = event.currentTarget;
                        }}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <a
                          href={downloadHref(projectId, item.id)}
                          download={item.filename}
                        >
                          <Download data-icon="inline-start" />
                          Download
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onRename(item)}>
                        <Pencil data-icon="inline-start" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onDelete(item)}
                        className="text-danger"
                      >
                        <Trash2 data-icon="inline-start" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
