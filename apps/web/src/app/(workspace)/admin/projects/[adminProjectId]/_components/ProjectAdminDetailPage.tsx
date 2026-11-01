"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ClientDate } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ProjectMembersCard } from "./ProjectMembersCard";

const SEARCH_DEBOUNCE_MS = 250;

export function ProjectAdminDetailPage({ projectId }: { projectId: string }) {
  const utils = api.useUtils();
  const projectQuery = api.adminProject.get.useQuery({ projectId });
  const meQuery = api.account.me.useQuery();
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(rawSearch.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rawSearch]);

  const candidatesQuery = api.user.list.useQuery({
    search: search || undefined,
    limit: 20,
  });

  const setMembership = api.user.setMembership.useMutation({
    onSuccess: () => {
      toast.success("Membership updated");
      void utils.adminProject.invalidate();
      void utils.user.get.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Could not update the membership");
    },
  });

  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  const presentation = resolveQueryPresentation({
    data: project,
    error: projectQuery.error,
    isLoading: projectQuery.isLoading,
  });

  if (presentation === "loading") {
    return (
      <div className="flex w-full flex-col gap-4">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (presentation === "error" || !project) {
    const notFound = projectQuery.error?.data?.code === "NOT_FOUND";
    return (
      <div className="border-danger-border bg-danger-bg flex w-full flex-col items-start gap-3 rounded-xl border p-5">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          {notFound ? "Project not found" : "Project unavailable"}
        </h1>
        <p className="text-danger m-0 text-[13px]">
          {notFound
            ? "This project does not exist or has been deleted."
            : "Could not load this project."}
        </p>
        {notFound ? (
          <Button variant="outline" asChild>
            <Link href="/admin/projects">Back to projects</Link>
          </Button>
        ) : (
          <Button variant="outline" onClick={() => void projectQuery.refetch()}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const candidates =
    dataUnlessAccessError(candidatesQuery.data, candidatesQuery.error)?.users ??
    [];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-text m-0 flex items-center gap-2 text-[20px] font-semibold">
            {project.name}
            {project.isPersonal ? (
              <Badge variant="outline">Personal</Badge>
            ) : null}
          </h1>
          {project.description ? (
            <p className="text-text-3 m-0 text-[13px]">{project.description}</p>
          ) : null}
        </div>
        {project.callerIsMember ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/projects/${project.id}`}>Open project</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-text-3">Created</dt>
              <dd className="text-text m-0">
                <ClientDate value={project.createdAt} />
              </dd>
            </div>
            <div>
              <dt className="text-text-3">Members</dt>
              <dd className="text-text m-0">{project.memberCount}</dd>
            </div>
            <div>
              <dt className="text-text-3">Documents</dt>
              <dd className="text-text m-0">{project.documentCount}</dd>
            </div>
            <div>
              <dt className="text-text-3">Tables</dt>
              <dd className="text-text m-0">{project.tableCount}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <ProjectMembersCard
        projectName={project.name}
        members={project.members}
        callerId={meQuery.data?.id}
        candidates={candidates}
        userSearch={rawSearch}
        onUserSearchChange={setRawSearch}
        onSetMembership={(userId, role) =>
          setMembership.mutate({ userId, projectId, role })
        }
        pending={setMembership.isPending || meQuery.isLoading}
      />
    </div>
  );
}
