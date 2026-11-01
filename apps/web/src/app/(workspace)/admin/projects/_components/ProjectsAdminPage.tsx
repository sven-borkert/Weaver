"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";

type ProjectRow = RouterOutputs["adminProject"]["list"]["projects"][number];

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/** Presentational — takes `projects` as a prop so it renders without tRPC. */
export function ProjectsTable({ projects }: { projects: ProjectRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Owners</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Documents</TableHead>
          <TableHead>Tables</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell className="text-text text-[13px] font-medium">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link
                  href={`/admin/projects/${project.id}`}
                  className="hover:underline"
                >
                  {project.name}
                </Link>
                {project.isPersonal ? (
                  <Badge variant="outline">Personal</Badge>
                ) : null}
                {project.callerIsMember ? (
                  <Badge variant="secondary">Member</Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {project.owners.length === 0 ? (
                <span className="text-danger">No owner</span>
              ) : (
                project.owners.map((owner) => owner.name).join(", ")
              )}
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {project.memberCount}
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {project.documentCount}
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {project.tableCount}
            </TableCell>
            <TableCell className="text-text-3 text-[12px]">
              <ClientDate value={project.createdAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ProjectsAdminPage() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(rawSearch.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rawSearch]);

  const listQuery = api.adminProject.list.useInfiniteQuery(
    { search: search || undefined, limit: PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const data = dataUnlessAccessError(listQuery.data, listQuery.error);
  const presentation = resolveQueryPresentation({
    data,
    error: listQuery.error,
    isLoading: listQuery.isLoading,
  });
  const projects = data?.pages.flatMap((page) => page.projects) ?? [];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">Projects</h1>
        <p className="text-text-3 m-0 text-[13px]">
          Every project in this Weaver instance. Administrators see project
          metadata and members here; opening a project&apos;s content still
          requires membership.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-search">Search projects</Label>
        <Input
          id="project-search"
          type="search"
          placeholder="Search by name"
          value={rawSearch}
          onChange={(event) => setRawSearch(event.target.value)}
          className="max-w-sm"
        />
      </div>

      {presentation === "loading" ? (
        <div className="flex flex-col gap-2 py-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : presentation === "error" || !data ? (
        <p className="text-danger m-0 text-[13px]">Could not load projects.</p>
      ) : projects.length === 0 ? (
        <p className="text-text-3 m-0 text-[13px]">
          {search ? "No projects match your search." : "No projects yet."}
        </p>
      ) : (
        <>
          <ProjectsTable projects={projects} />
          {listQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
