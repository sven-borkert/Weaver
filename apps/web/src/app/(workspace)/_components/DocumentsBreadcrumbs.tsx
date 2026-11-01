"use client";

import { ChevronDown, Folder } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";

import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { documentKindIcon } from "~/components/icons/document-kind-icon";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  documentHref,
  folderHref,
  listFolderEntries,
} from "~/lib/documents/explorer";
import { folderDisplayName } from "~/lib/explorer/entries";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type FolderTree = RouterOutputs["folder"]["tree"];

export type DocumentsBreadcrumbCurrent =
  { kind: "folder" } | { kind: "document"; id: string; title: string };

type Props = {
  projectId: string;
  folderPath: string[];
  current: DocumentsBreadcrumbCurrent;
};

function SiblingMenu({
  projectId,
  path,
  label,
  tree,
  currentKey,
}: {
  projectId: string;
  path: string[];
  label: string;
  tree: FolderTree | undefined;
  currentKey: string | undefined;
}) {
  const entries = tree
    ? listFolderEntries(
        {
          folders: tree.folders,
          folderNames: tree.folderNames,
          items: tree.documents,
        },
        path,
      )
    : { folders: [], items: [] };
  const items = [...entries.folders, ...entries.items];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Show contents of ${label}`}
          className="text-text-3 hover:text-text size-5"
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-64 overflow-y-auto"
      >
        {items.length === 0 ? (
          <DropdownMenuItem disabled>Empty folder</DropdownMenuItem>
        ) : (
          items.map((entry) => {
            const key =
              entry.kind === "folder"
                ? `folder:${entry.path.join("/")}`
                : `document:${entry.id}`;
            const href =
              entry.kind === "folder"
                ? folderHref(projectId, entry.path)
                : documentHref(projectId, entry.id);
            const Icon =
              entry.kind === "folder"
                ? Folder
                : documentKindIcon(entry.documentKind);
            return (
              <DropdownMenuItem
                key={key}
                asChild
                className={cn(
                  key === currentKey && "bg-brand-bg text-brand-text",
                )}
              >
                <Link
                  href={href}
                  aria-current={key === currentKey ? "page" : undefined}
                >
                  <Icon className="text-text-2 size-4" aria-hidden="true" />
                  <span className="truncate">
                    {entry.kind === "folder" ? entry.name : entry.title}
                  </span>
                </Link>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DocumentsBreadcrumbs({
  projectId,
  folderPath,
  current,
}: Props) {
  const treeQuery = api.folder.tree.useQuery(
    { projectId },
    { enabled: projectId.length > 0 },
  );
  const tree = dataUnlessAccessError(treeQuery.data, treeQuery.error);
  const isDocument = current.kind === "document";
  const currentKey =
    current.kind === "document"
      ? `document:${current.id}`
      : folderPath.length
        ? `folder:${folderPath.join("/")}`
        : undefined;
  const crumbs: Array<{ label: string; path: string[] }> = [
    { label: "Documents", path: [] },
    ...folderPath.map((_, index) => ({
      label: folderDisplayName(
        tree?.folderNames,
        folderPath.slice(0, index + 1),
      ),
      path: folderPath.slice(0, index + 1),
    })),
  ];

  return (
    <>
      {crumbs.map((crumb, index) => {
        // Folder view: the last crumb is the page itself and gets no menu.
        const isPage = !isDocument && index === crumbs.length - 1;
        return (
          <Fragment key={crumb.path.join("/") || "root"}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem className="gap-0.5">
              {isPage ? (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href={folderHref(projectId, crumb.path)}>
                    {crumb.label}
                  </Link>
                </BreadcrumbLink>
              )}
              {isPage ? null : (
                <SiblingMenu
                  projectId={projectId}
                  path={crumb.path}
                  label={crumb.label}
                  tree={tree}
                  currentKey={currentKey}
                />
              )}
            </BreadcrumbItem>
          </Fragment>
        );
      })}
      {current.kind === "document" ? (
        <>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{current.title}</BreadcrumbPage>
          </BreadcrumbItem>
        </>
      ) : null}
    </>
  );
}
