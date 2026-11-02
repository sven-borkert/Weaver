"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { projectRoleAtLeast } from "@weaver/core/roles";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { DeleteProjectDialog } from "./_components/DeleteProjectDialog";
import { DocumentReviewCard } from "./_components/DocumentReviewCard";
import { DocumentMaintenanceCard } from "./_components/DocumentMaintenanceCard";
import { GitRemoteCard } from "./_components/GitRemoteCard";
import { KnowledgeIndexCard } from "./_components/KnowledgeIndexCard";
import { MachineApiKeysCard } from "./_components/MachineApiKeysCard";
import { MembersSection } from "./_components/MembersSection";
import { ProjectSettingsForm } from "./_components/ProjectSettingsForm";
import { TableMaintenanceCard } from "./_components/TableMaintenanceCard";
import { WikiCard } from "./_components/WikiCard";

function SettingsSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const projectQuery = api.project.get.useQuery(
    { projectId },
    { enabled: projectId.length > 0 },
  );

  // Transient refetch errors keep the forms mounted; access errors clear them.
  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);

  if (!project) {
    if (projectQuery.isLoading) return <SettingsSkeleton />;
    return (
      <div className="flex w-full flex-col items-start gap-2">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          Project not found
        </h1>
        <p className="text-text-3 m-0 text-[13px]">
          This project may have been deleted, or you do not have access to it.
        </p>
        <Button asChild variant="outline" className="mt-2">
          <Link href="/">Back to your documents</Link>
        </Button>
      </div>
    );
  }

  const canEdit = projectRoleAtLeast(project.myRole, "Editor");
  const canManageMembers = projectRoleAtLeast(project.myRole, "Maintainer");
  const isOwner = project.myRole === "Owner";
  const canDelete = isOwner && !project.personalOwnerId;

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">
          {project.name}
        </h1>
        {project.personalOwnerId ? (
          <Badge variant="secondary" className="w-fit">
            Personal workspace
          </Badge>
        ) : null}
        {project.description ? (
          <p className="text-text-3 m-0 text-[13px]">{project.description}</p>
        ) : null}
      </div>

      <ProjectSettingsForm
        key={project.id}
        project={project}
        canEdit={canEdit}
      />

      <MembersSection
        projectId={project.id}
        myRole={project.myRole}
        canManage={canManageMembers}
      />

      <MachineApiKeysCard
        key={`project-api-keys:${project.id}`}
        projectId={project.id}
        canManage={canManageMembers}
      />

      <DocumentReviewCard projectId={project.id} />

      {canManageMembers ? (
        <DocumentMaintenanceCard projectId={project.id} />
      ) : null}

      {canManageMembers ? (
        <TableMaintenanceCard projectId={project.id} />
      ) : null}

      {canManageMembers ? <KnowledgeIndexCard projectId={project.id} /> : null}

      {canManageMembers ? (
        <WikiCard
          key={`wiki:${project.id}`}
          projectId={project.id}
          isOwner={isOwner}
        />
      ) : null}

      {isOwner ? (
        <GitRemoteCard
          key={`git-remote:${project.id}`}
          projectId={project.id}
        />
      ) : null}

      {canDelete ? (
        <DeleteProjectDialog
          projectId={project.id}
          projectName={project.name}
        />
      ) : null}
    </div>
  );
}
