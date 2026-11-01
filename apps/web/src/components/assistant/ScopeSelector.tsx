"use client";

import { ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MAX_SCOPE_PROJECTS,
  type ScopeRequest,
} from "@weaver/core/assistant/scopeSchema";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import type { PageContext } from "~/lib/assistant/scopeDraft";
import {
  folderLabel,
  scopeLabel,
  toggleScopeProject,
} from "~/lib/assistant/scopeDraft";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

export function scopeOptions(
  page: PageContext,
): Array<"document" | "table" | "project"> {
  const options: Array<"document" | "table" | "project"> = [];
  if (page.projectId && page.documentId) options.push("document");
  if (page.projectId && page.tableId) options.push("table");
  if (page.projectId) options.push("project");
  return options;
}

type Props = {
  draft: ScopeRequest;
  onChange: (draft: ScopeRequest) => void;
  page: PageContext;
  accessibleProjects: Array<{ id: string; name: string }>;
  truncated?: boolean;
  dropped?: number;
};

function Option({
  selected,
  onSelect,
  children,
  disabled,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "hover:bg-hover flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-[13px] disabled:opacity-50",
        selected && "bg-subtle",
      )}
    >
      <span>{children}</span>
      {hint ? (
        <span className="text-text-muted text-[11px]">{hint}</span>
      ) : null}
    </button>
  );
}

export function ScopeSelector({
  draft,
  onChange,
  page,
  accessibleProjects,
  truncated,
  dropped,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Names come from the draft first, the page only as a fallback: an already
  // seeded draft stays pinned to its original document/table while the page
  // navigates away (spec §6.2), and §6.3 requires the button to name the
  // draft. Each id is paired with the project id it belongs to, so a draft
  // pointing into another project never resolves against the page's project.
  const documentTarget =
    draft.kind === "document"
      ? { projectId: draft.projectId, documentId: draft.documentId }
      : page.projectId && page.documentId
        ? { projectId: page.projectId, documentId: page.documentId }
        : null;
  const tableTarget =
    draft.kind === "table"
      ? { projectId: draft.projectId, tableId: draft.tableId }
      : page.projectId && page.tableId
        ? { projectId: page.projectId, tableId: page.tableId }
        : null;
  const projectId = "projectId" in draft ? draft.projectId : page.projectId;
  const documentQuery = api.document.get.useQuery(
    {
      projectId: documentTarget?.projectId ?? "",
      documentId: documentTarget?.documentId ?? "",
    },
    { enabled: Boolean(documentTarget) },
  );
  const tableQuery = api.table.get.useQuery(
    {
      projectId: tableTarget?.projectId ?? "",
      tableId: tableTarget?.tableId ?? "",
    },
    { enabled: Boolean(tableTarget) },
  );
  const projectQuery = api.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId) },
  );
  // An option row names what *choosing it* would scope to, which is always
  // the page's document/table/project — never the draft's. Whenever the two
  // coincide (the common case) these share the query above's cache entry.
  const pageDocumentQuery = api.document.get.useQuery(
    { projectId: page.projectId ?? "", documentId: page.documentId ?? "" },
    { enabled: Boolean(page.projectId && page.documentId) },
  );
  const pageTableQuery = api.table.get.useQuery(
    { projectId: page.projectId ?? "", tableId: page.tableId ?? "" },
    { enabled: Boolean(page.projectId && page.tableId) },
  );
  const pageProjectQuery = api.project.get.useQuery(
    { projectId: page.projectId ?? "" },
    { enabled: Boolean(page.projectId) },
  );

  // Folders are offered for the project the draft or the page points at.
  const folders = api.assistant.listScopeFolders.useQuery(
    { projectId: projectId ?? "" },
    { enabled: open && Boolean(projectId) },
  );

  const label = scopeLabel(draft, {
    document: documentQuery.data?.title,
    table: tableQuery.data?.title,
    project: projectQuery.data?.name,
    projectCount: accessibleProjects.length,
  });
  const options = scopeOptions(page);
  // Selection is an id comparison, not a kind check: a draft pinned to
  // another document is still `kind: "document"`, but the row here would
  // scope to the page's document, so it is not the current selection.
  const documentSelected =
    draft.kind === "document" &&
    draft.projectId === page.projectId &&
    draft.documentId === page.documentId;
  const tableSelected =
    draft.kind === "table" &&
    draft.projectId === page.projectId &&
    draft.tableId === page.tableId;
  const projectSelected =
    draft.kind === "project" && draft.projectId === page.projectId;
  const selectedIds = useMemo(
    () => new Set(draft.kind === "projects" ? draft.projectIds : []),
    [draft],
  );
  const visibleProjects = accessibleProjects.filter((p) =>
    p.name.toLowerCase().includes(filter.toLowerCase()),
  );

  const toggleProject = (id: string) => onChange(toggleScopeProject(draft, id));

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Scope: ${label}`}
            className="max-w-full justify-start gap-1 text-[12px]"
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <div
            role="listbox"
            aria-label="Scope"
            className="flex flex-col gap-0.5"
          >
            <Option
              selected={documentSelected}
              disabled={!options.includes("document")}
              hint={
                options.includes("document")
                  ? undefined
                  : "Open a document to use this"
              }
              onSelect={() => {
                onChange({
                  kind: "document",
                  projectId: page.projectId!,
                  documentId: page.documentId!,
                });
                setOpen(false);
              }}
            >
              Focus on this document (project context allowed)
              {pageDocumentQuery.data
                ? ` · ${pageDocumentQuery.data.title}`
                : ""}
            </Option>
            <Option
              selected={tableSelected}
              disabled={!options.includes("table")}
              hint={
                options.includes("table")
                  ? undefined
                  : "Open a table to use this"
              }
              onSelect={() => {
                onChange({
                  kind: "table",
                  projectId: page.projectId!,
                  tableId: page.tableId!,
                });
                setOpen(false);
              }}
            >
              Focus on this table (project context allowed)
              {pageTableQuery.data ? ` · ${pageTableQuery.data.title}` : ""}
            </Option>
            {options.includes("project") ? (
              <Option
                selected={projectSelected}
                onSelect={() => {
                  onChange({ kind: "project", projectId: page.projectId! });
                  setOpen(false);
                }}
              >
                This project
                {pageProjectQuery.data
                  ? ` · ${pageProjectQuery.data.name}`
                  : ""}
              </Option>
            ) : null}
            {projectId && folders.data?.length ? (
              <div
                role="group"
                aria-label="Folders"
                className="border-line my-1 border-y py-1"
              >
                <p className="text-text-2 px-2 pb-0.5 text-[11px]">
                  Restrict to a folder
                  {projectQuery.data ? ` of ${projectQuery.data.name}` : ""}
                </p>
                <div className="scrollarea max-h-40 overflow-y-auto">
                  {folders.data.map((folder) => {
                    const key = `${folder.resourceType}:${folder.path.join("/")}`;
                    return (
                      <Option
                        key={key}
                        selected={
                          draft.kind === "folder" &&
                          draft.projectId === projectId &&
                          `${draft.resourceType}:${draft.folderPath.join("/")}` ===
                            key
                        }
                        onSelect={() => {
                          onChange({
                            kind: "folder",
                            projectId,
                            resourceType: folder.resourceType,
                            folderPath: folder.path,
                          });
                          setOpen(false);
                        }}
                      >
                        {folderLabel(folder.resourceType, folder.path)}
                      </Option>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <Option
              selected={draft.kind === "all"}
              onSelect={() => {
                onChange({ kind: "all" });
                setOpen(false);
              }}
            >
              All accessible projects ({accessibleProjects.length})
            </Option>
          </div>
          <div className="border-line mt-2 border-t pt-2">
            <p className="text-text-2 mb-1 text-[11px]">
              Selected projects
              {selectedIds.size ? ` (${selectedIds.size})` : ""}
            </p>
            <div className="relative mb-1">
              <Search
                className="text-text-muted absolute top-1/2 left-2 size-3 -translate-y-1/2"
                aria-hidden="true"
              />
              <Input
                aria-label="Filter projects"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 pl-6 text-[12px]"
              />
            </div>
            <ul className="scrollarea max-h-48 overflow-y-auto">
              {visibleProjects.map((p) => {
                const checked = selectedIds.has(p.id);
                return (
                  <li key={p.id}>
                    <label className="hover:bg-hover flex items-center gap-2 rounded px-2 py-1 text-[13px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={
                          !checked && selectedIds.size >= MAX_SCOPE_PROJECTS
                        }
                        onChange={() => toggleProject(p.id)}
                      />
                      <span className="truncate">{p.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </PopoverContent>
      </Popover>
      {/*
        These notices sit outside PopoverContent (which Radix only mounts
        into a document.body portal, i.e. never during SSR/static-markup
        tests) so they are both immediately visible without opening the
        selector and independently assertable in tests.
      */}
      {truncated && draft.kind === "all" ? (
        <p className="text-text-muted text-[11px]">
          Last answer was limited to 100 projects — pick selected projects to
          narrow.
        </p>
      ) : null}
      {dropped ? (
        <p className="text-text-muted text-[11px]">
          {dropped} project{dropped === 1 ? " is" : "s are"} no longer
          accessible.
        </p>
      ) : null}
    </div>
  );
}
