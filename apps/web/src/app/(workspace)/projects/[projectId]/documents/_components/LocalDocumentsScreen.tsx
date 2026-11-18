"use client";

import { projectRoleAtLeast } from "@weaver/core/roles";
import {
  ChevronRight,
  Ellipsis,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { withBasePath } from "~/lib/basePath";
import { localDocumentsHref } from "~/lib/documents/local-documents-url";
import {
  dataUnlessAccessError,
  isQueryAccessError,
  queryErrorCode,
} from "~/lib/query-presentation";
import { api, useSessionExpired, type RouterOutputs } from "~/trpc/react";
import { DocumentsWorkspace } from "./DocumentsWorkspace";
import {
  WorkspaceEmpty,
  WorkspaceError,
  WorkspaceLoading,
  WorkspaceNotFound,
} from "./DocumentStates";
import { LocalEntryDialog, type LocalEntryAction } from "./LocalEntryDialog";
import { LocalDocumentEditor } from "./LocalDocumentEditor";

export type LocalEntrySummary = RouterOutputs["localDocument"]["list"][number];

export function LocalDocumentsScreen({
  projectId,
  selection,
}: {
  projectId: string;
  selection: { folder?: string; document?: string } | null;
}) {
  const sessionExpired = useSessionExpired();
  const [unverifiedAt, setUnverifiedAt] = useState<number[] | null>(null);
  const refetchOnWindowFocus = unverifiedAt ? ("always" as const) : true;
  const project = api.project.get.useQuery(
    { projectId },
    { refetchOnWindowFocus },
  );
  const projectData = dataUnlessAccessError(project.data, project.error);
  const list = api.localDocument.list.useQuery(
    { projectId },
    { enabled: Boolean(projectData && selection), refetchOnWindowFocus },
  );
  const entryId = selection?.document;
  const detail = api.localDocument.get.useQuery(
    { projectId, entryId: entryId ?? "" },
    { enabled: Boolean(entryId && projectData), refetchOnWindowFocus },
  );
  const { refetch: refetchProject } = project;
  const { refetch: refetchList } = list;
  const { refetch: refetchDetail } = detail;
  const hasSelection = Boolean(selection);
  const accessQueries = [
    project,
    ...(selection ? [list] : []),
    ...(entryId ? [detail] : []),
  ];
  const lostSession =
    sessionExpired ||
    accessQueries.some(
      (query) => queryErrorCode(query.error) === "UNAUTHORIZED",
    );
  if (lostSession && !unverifiedAt)
    setUnverifiedAt(accessQueries.map((query) => query.dataUpdatedAt));
  const accessRefetched =
    unverifiedAt &&
    accessQueries.every(
      (query, index) =>
        query.isSuccess && query.dataUpdatedAt > (unverifiedAt[index] ?? 0),
    );
  if (!lostSession && accessRefetched) setUnverifiedAt(null);
  const suspended = lostSession || (unverifiedAt !== null && !accessRefetched);
  const refreshAccess = useCallback(async () => {
    const results = await Promise.all([
      refetchProject(),
      ...(hasSelection ? [refetchList()] : []),
      ...(entryId ? [refetchDetail()] : []),
    ]);
    return results.every((result) => result.isSuccess);
  }, [refetchProject, refetchList, refetchDetail, hasSelection, entryId]);
  const confirmAccess = useCallback((confirmed: boolean) => {
    if (confirmed) setUnverifiedAt(null);
  }, []);
  useEffect(() => {
    if (unverifiedAt && !sessionExpired)
      void refreshAccess().then(confirmAccess);
  }, [unverifiedAt, sessionExpired, refreshAccess, confirmAccess]);

  const denied = (error: unknown) =>
    isQueryAccessError(error) && queryErrorCode(error) !== "UNAUTHORIZED";
  const accessError = denied(project.error) || denied(list.error);
  const entries = suspended
    ? list.data
    : dataUnlessAccessError(list.data, list.error);
  const root = localDocumentsHref(projectId);
  const listError = project.error ?? list.error;
  const canEdit = Boolean(
    !suspended &&
    projectData &&
    projectRoleAtLeast(projectData.myRole, "Editor"),
  );
  const entry = suspended
    ? detail.data
    : dataUnlessAccessError(detail.data, detail.error);

  let content;
  if (accessError) {
    content = <WorkspaceNotFound />;
  } else if (
    entryId &&
    entry?.kind === "document" &&
    !denied(detail.error) &&
    (entries || suspended)
  ) {
    content = (
      <div hidden={suspended} inert={suspended}>
        <LocalDocumentView
          key={`${projectId}:${entryId}`}
          projectId={projectId}
          entry={entry}
          entries={entries ?? []}
          canEdit={canEdit}
          error={suspended ? null : detail.error}
          retry={() => void detail.refetch()}
        />
      </div>
    );
  } else if (suspended) {
    content = null;
  } else if (!selection) {
    content = <MissingEntry root={root} />;
  } else if (!entries && listError) {
    content = (
      <WorkspaceError
        title="Could not load Outside Git"
        action={
          <Button
            variant="outline"
            onClick={() => {
              if (projectData) void list.refetch();
              else void project.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (!entries) {
    content = <WorkspaceLoading title="Loading Outside Git" />;
  } else if (entryId) {
    content =
      denied(detail.error) || entry ? (
        <MissingEntry root={root} />
      ) : detail.error ? (
        <WorkspaceError
          title="Could not load the document"
          action={
            <Button variant="outline" onClick={() => void detail.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <WorkspaceLoading title="Loading document" />
      );
  } else {
    const folder = entries.find(
      (entry) => entry.kind === "folder" && entry.id === selection.folder,
    );
    content =
      selection.folder && !folder ? (
        list.error ? (
          <WorkspaceError
            title="Could not load the folder"
            action={
              <Button variant="outline" onClick={() => void list.refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <MissingEntry root={root} />
        )
      ) : (
        <LocalFolderView
          key={`${projectId}:${folder?.id ?? "root"}`}
          projectId={projectId}
          entries={entries}
          folder={folder}
          canEdit={canEdit}
        />
      );
  }

  return (
    <DocumentsWorkspace>
      {suspended && !accessError ? (
        <WorkspaceError
          title="Document access needs to be restored"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {lostSession && !sessionExpired ? (
                <Button variant="outline" asChild>
                  <a
                    href={withBasePath("/login")}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Sign in again in a new tab
                  </a>
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={
                  sessionExpired ||
                  project.isFetching ||
                  list.isFetching ||
                  detail.isFetching
                }
                onClick={() => void refreshAccess().then(confirmAccess)}
              >
                Retry access
              </Button>
            </div>
          }
        />
      ) : null}
      {entries && list.error && !suspended ? (
        <div
          role="status"
          className="border-line bg-surface-2 flex items-center justify-between gap-3 border-b px-5 py-2 text-sm"
        >
          Folder listings may be out of date.
          <Button
            size="sm"
            variant="outline"
            onClick={() => void list.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {content}
    </DocumentsWorkspace>
  );
}

function MissingEntry({ root }: { root: string }) {
  return (
    <WorkspaceNotFound
      title="Item not found"
      description="This document or folder is unavailable."
      action={
        <Button variant="outline" asChild>
          <Link href={root}>Outside Git</Link>
        </Button>
      }
    />
  );
}

function LocalFolderTrail({
  projectId,
  entries,
  parentId,
}: {
  projectId: string;
  entries: LocalEntrySummary[];
  parentId: string | null;
}) {
  const folders = new Map(
    entries
      .filter((entry) => entry.kind === "folder")
      .map((entry) => [entry.id, entry]),
  );
  const trail: LocalEntrySummary[] = [];
  for (let id = parentId; id;) {
    const folder = folders.get(id);
    if (!folder) break;
    folders.delete(id);
    trail.unshift(folder);
    id = folder.parentId;
  }
  return (
    <nav aria-label="Folder location">
      <ol className="text-text-3 flex flex-wrap items-center gap-1.5 text-sm">
        <li>
          <Link
            className="hover:text-brand-text hover:underline"
            href={`/projects/${projectId}/documents`}
          >
            Documents
          </Link>
        </li>
        <li className="flex items-center gap-1.5">
          <ChevronRight aria-hidden="true" className="size-3" />
          <Link
            className="hover:text-brand-text hover:underline"
            href={localDocumentsHref(projectId)}
          >
            Outside Git
          </Link>
        </li>
        {trail.map((folder) => (
          <li
            key={folder.id}
            className="flex max-w-full min-w-0 items-center gap-1.5"
          >
            <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
            <Link
              className="hover:text-brand-text truncate hover:underline"
              href={localDocumentsHref(projectId, { folder: folder.id })}
            >
              {folder.title}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LocalFolderView({
  projectId,
  entries,
  folder,
  canEdit,
}: {
  projectId: string;
  entries: LocalEntrySummary[];
  folder?: LocalEntrySummary;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<LocalEntryAction | null>(null);
  const heading = useId();
  const focusTarget = useRef<HTMLElement>(null);
  const parentId = folder?.id ?? null;
  const children = entries
    .filter((entry) => entry.parentId === parentId)
    .sort((left, right) =>
      left.kind === right.kind
        ? left.title.localeCompare(right.title)
        : left.kind === "folder"
          ? -1
          : 1,
    );
  const openDialog = (next: LocalEntryAction) => setAction(next);
  if (!canEdit && action) setAction(null);

  const openCreated = (created: LocalEntrySummary) => {
    const target = localDocumentsHref(
      projectId,
      created.kind === "folder"
        ? { folder: created.id }
        : { document: created.id },
    );
    if (confirmNavigation(withBasePath(target))) router.push(target);
  };

  return (
    <section
      ref={focusTarget}
      aria-labelledby={heading}
      tabIndex={-1}
      className="px-4 py-6 outline-none sm:px-6"
    >
      <LocalFolderTrail
        projectId={projectId}
        entries={entries}
        parentId={folder?.parentId ?? null}
      />
      <header className="mt-3 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            id={heading}
            className="text-text text-xl font-semibold wrap-break-word"
          >
            {folder?.title ?? "Outside Git"}
          </h1>
          {!folder ? (
            <p className="text-text-3 mt-1 text-sm">
              Documents and folders stored in Weaver outside the project’s Git
              repository.
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              aria-haspopup="dialog"
              onClick={(event) =>
                openDialog({
                  type: "create",
                  kind: "folder",
                  parentId,
                  trigger: event.currentTarget,
                })
              }
            >
              <FolderPlus data-icon="inline-start" />
              New folder
            </Button>
            <Button
              aria-haspopup="dialog"
              onClick={(event) =>
                openDialog({
                  type: "create",
                  kind: "document",
                  parentId,
                  trigger: event.currentTarget,
                })
              }
            >
              <FilePlus2 data-icon="inline-start" />
              New document
            </Button>
          </div>
        ) : null}
      </header>
      {children.length ? (
        <ul
          aria-label="Folder contents"
          className="border-line divide-line divide-y rounded-lg border"
        >
          {children.map((entry) => (
            <LocalEntryRow
              key={entry.id}
              projectId={projectId}
              entry={entry}
              onAction={canEdit ? openDialog : undefined}
            />
          ))}
        </ul>
      ) : (
        <WorkspaceEmpty
          title={
            folder ? "This folder is empty" : "No documents or folders yet"
          }
          description={
            canEdit ? "Create a document or folder to get started." : ""
          }
        />
      )}
      {canEdit && action ? (
        <LocalEntryDialog
          projectId={projectId}
          action={action}
          focusFallback={focusTarget}
          onClose={() => setAction(null)}
          onCreated={openCreated}
        />
      ) : null}
    </section>
  );
}

function LocalEntryRow({
  projectId,
  entry,
  onAction,
}: {
  projectId: string;
  entry: LocalEntrySummary;
  onAction?: (action: LocalEntryAction) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const Icon = entry.kind === "folder" ? Folder : FileText;
  return (
    <li className="flex min-w-0 items-center gap-1 px-2">
      <Link
        href={localDocumentsHref(
          projectId,
          entry.kind === "folder"
            ? { folder: entry.id }
            : { document: entry.id },
        )}
        className="text-text hover:bg-hover hover:text-brand-text flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm"
      >
        <Icon aria-hidden="true" className="text-text-3 size-4 shrink-0" />
        <span className="min-w-0 wrap-break-word">{entry.title}</span>
      </Link>
      {onAction ? (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) openingDialog.current = false;
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              aria-label={`Actions for ${entry.title}`}
              variant="ghost"
              size="icon"
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (openingDialog.current) event.preventDefault();
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                openingDialog.current = true;
                onAction({ type: "rename", entry, trigger: trigger.current });
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                openingDialog.current = true;
                onAction({ type: "delete", entry, trigger: trigger.current });
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

function LocalDocumentView({
  projectId,
  entry,
  entries,
  canEdit,
  error,
  retry,
}: {
  projectId: string;
  entry: RouterOutputs["localDocument"]["get"];
  entries: LocalEntrySummary[];
  canEdit: boolean;
  error: unknown;
  retry: () => void;
}) {
  return (
    <div className="px-4 py-6 sm:px-6">
      <LocalFolderTrail
        projectId={projectId}
        entries={entries}
        parentId={entry.parentId}
      />
      {error ? (
        <div
          className="text-text-3 mt-2 flex items-center gap-3 text-sm"
          role="status"
        >
          The latest document could not be loaded.
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
      <LocalDocumentEditor
        projectId={projectId}
        entry={entry}
        canEdit={canEdit}
      />
    </div>
  );
}
