"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { focusDialogTarget } from "~/lib/dialog-focus";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ArtifactUpload } from "./ArtifactUpload";
import {
  ArtifactsTable,
  type ArtifactRow,
  type ArtifactSort,
} from "./ArtifactsTable";
import {
  artifactsListBody,
  clampPage,
  pageAfterDelete,
} from "./artifacts-state";
import { notebookInProgress } from "./NotebookStatus";
import { RenameArtifactDialog } from "./RenameArtifactDialog";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;
const NOTEBOOK_POLL_MS = 5000;
/** listArtifactsInput.search caps the term at 200, while a deep link may name
 *  a filename of up to 255: a substring of it still finds the file. */
const MAX_SEARCH_CHARS = 200;

/** The row stays addressable while the dialog plays its close animation. */
type DialogTarget = { artifact: ArtifactRow | null; open: boolean };

export function ArtifactsScreen({
  projectId,
  maxFileBytes,
  focusFilename,
}: {
  projectId: string;
  maxFileBytes: number;
  focusFilename: string | null;
}) {
  const utils = api.useUtils();
  const seededSearch = (focusFilename ?? "").slice(0, MAX_SEARCH_CHARS);
  const [search, setSearch] = useState(seededSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(seededSearch);
  const [page, setPage] = useState(1);
  const [lastPageCount, setLastPageCount] = useState(1);
  const [sort, setSort] = useState<ArtifactSort>("filename");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [rename, setRename] = useState<DialogTarget>({
    artifact: null,
    open: false,
  });
  const [remove, setRemove] = useState<DialogTarget>({
    artifact: null,
    open: false,
  });
  const screenRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const appliedSearch = useRef(debouncedSearch);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search.slice(0, MAX_SEARCH_CHARS)),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (appliedSearch.current === debouncedSearch) return;
    appliedSearch.current = debouncedSearch;
    setPage(1);
  }, [debouncedSearch]);

  const projectQuery = api.project.get.useQuery({ projectId });
  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  const canEdit = !!project && projectRoleAtLeast(project.myRole, "Editor");
  const listQuery = api.artifact.list.useQuery(
    {
      projectId,
      page,
      pageSize: PAGE_SIZE,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      sort,
      dir,
    },
    {
      placeholderData: keepPreviousData,
      refetchInterval: (query) =>
        query.state.data?.items.some((item) =>
          notebookInProgress(item.notebook),
        )
          ? NOTEBOOK_POLL_MS
          : false,
    },
  );
  const presentation = resolveQueryPresentation(listQuery);
  const list = dataUnlessAccessError(listQuery.data, listQuery.error);
  const items = list?.items ?? [];
  const pageCount = list?.pageCount ?? 1;
  const body = artifactsListBody(
    presentation,
    Boolean(debouncedSearch),
    items.length,
  );

  // Rows deleted elsewhere can shrink the list under the current page.
  if (list && list.pageCount !== lastPageCount) {
    setLastPageCount(list.pageCount);
    setPage((current) => clampPage(current, list.pageCount));
  }

  const deleteArtifact = api.artifact.delete.useMutation({
    onSuccess: () => {
      setPage((current) => pageAfterDelete(current, items.length));
      setRemove((current) => ({ ...current, open: false }));
      toast.success("File deleted");
      void utils.artifact.list.invalidate({ projectId });
    },
  });

  const onSort = (column: ArtifactSort) => {
    setDir(sort === column && dir === "asc" ? "desc" : "asc");
    setSort(column);
    setPage(1);
  };

  return (
    <div
      ref={screenRef}
      role="region"
      aria-label="Files"
      tabIndex={-1}
      className="flex w-full flex-col gap-4 outline-none"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">Files</h1>
        <p className="text-text-3 m-0 text-[13px]">
          Keep files of any type next to this project&rsquo;s documents.
          Download them here.
        </p>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="artifact-search" className="text-text-2 text-xs">
            Search
          </Label>
          <Input
            id="artifact-search"
            value={search}
            maxLength={MAX_SEARCH_CHARS}
            placeholder="File name"
            className="w-64"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={listQuery.isFetching}
          onClick={() => void listQuery.refetch()}
        >
          Refresh
        </Button>
      </div>
      {canEdit ? (
        <ArtifactUpload
          projectId={projectId}
          maxFileBytes={maxFileBytes}
          existingFilenames={items.map((item) => item.filename)}
          onUploaded={() => void utils.artifact.list.invalidate({ projectId })}
        />
      ) : null}
      {listQuery.error ? (
        <div role="alert" className="text-danger text-sm">
          {list
            ? "File list could not refresh. Showing the last loaded files."
            : "Could not load files."}{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {body === "loading" ? (
        <Skeleton className="h-24 w-full" />
      ) : body === "hidden" ? null : body === "no-matches" ? (
        <div className="border-line bg-surface rounded-[10px] border p-6">
          <p className="text-text m-0 text-sm font-medium">No matching files</p>
          <p className="text-text-2 mt-1 mb-0 text-sm">
            Change the search term to see more files.
          </p>
        </div>
      ) : (
        <ArtifactsTable
          items={items}
          canEdit={canEdit}
          projectId={projectId}
          focusFilename={focusFilename}
          sort={sort}
          dir={dir}
          onSort={onSort}
          onRename={(item) => setRename({ artifact: item, open: true })}
          onDelete={(item) => {
            deleteArtifact.reset();
            setRemove({ artifact: item, open: true });
          }}
          triggerRef={triggerRef}
        />
      )}
      {body === "table" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-3 m-0 text-[13px]">
            Page {page} of {pageCount}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page <= 1 || listQuery.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page >= pageCount || listQuery.isFetching}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
      <RenameArtifactDialog
        projectId={projectId}
        artifact={rename.artifact}
        open={rename.open}
        onOpenChange={(open) => setRename((current) => ({ ...current, open }))}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current, screenRef.current);
        }}
      />
      <Dialog
        open={remove.open}
        onOpenChange={(open) => {
          if (!deleteArtifact.isPending)
            setRemove((current) => ({ ...current, open }));
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-busy={deleteArtifact.isPending || undefined}
          showCloseButton={!deleteArtifact.isPending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(triggerRef.current, screenRef.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete file</DialogTitle>
            <DialogDescription>
              Delete <strong>{remove.artifact?.filename}</strong>? The file is
              removed permanently and cannot be restored.
            </DialogDescription>
          </DialogHeader>
          {deleteArtifact.error ? (
            <p role="alert" className="text-danger m-0 text-xs">
              Could not delete this file. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleteArtifact.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteArtifact.isPending || !remove.artifact}
              onClick={() => {
                if (remove.artifact)
                  deleteArtifact.mutate({
                    projectId,
                    artifactId: remove.artifact.id,
                  });
              }}
            >
              {deleteArtifact.isPending ? "Deleting…" : "Delete file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
