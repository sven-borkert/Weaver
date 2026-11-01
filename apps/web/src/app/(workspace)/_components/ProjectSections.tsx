"use client";

import {
  Activity,
  GraduationCap,
  CalendarClock,
  FileText,
  FileUp,
  Files,
  Settings,
  Table2,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { projectRoleAtLeast, type ProjectRoleName } from "@weaver/core/roles";

import { useActiveProjectId } from "~/lib/navigation/use-active-project-id";
import {
  dataUnlessAccessError,
  isQueryAccessError,
} from "~/lib/query-presentation";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { RailLink } from "./RailLink";

const SECTION_ICONS = {
  Documents: FileText,
  Tables: Table2,
  Files: Files,
  Graph: Waypoints,
  Imports: FileUp,
  Tasks: CalendarClock,
  Exams: GraduationCap,
  Activity: Activity,
  Settings: Settings,
} as const;

export function projectSections(
  projectId: string,
  role: ProjectRoleName,
  trainingRole: "trainer" | "trainee" | null = null,
) {
  const base = `/projects/${projectId}`;
  const sections: Array<{ label: keyof typeof SECTION_ICONS; href: string }> = [
    { label: "Documents", href: `${base}/documents` },
    { label: "Tables", href: `${base}/tables` },
    { label: "Files", href: `${base}/artifacts` },
    { label: "Graph", href: `${base}/graph` },
    ...(projectRoleAtLeast(role, "Editor")
      ? [{ label: "Imports" as const, href: `${base}/imports` }]
      : []),
    { label: "Tasks", href: `${base}/tasks` },
    ...(trainingRole
      ? [{ label: "Exams" as const, href: `${base}/exams` }]
      : []),
    { label: "Activity", href: `${base}/activity` },
    { label: "Settings", href: `${base}/settings` },
  ];
  return sections;
}

export function ProjectSections({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { projectId } = useActiveProjectId();
  const projectQuery = api.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId) },
  );
  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  if (!projectId || isQueryAccessError(projectQuery.error)) return null;
  const name = project?.name ?? "Project";
  const role: ProjectRoleName = project?.myRole ?? "Viewer";
  const isSectionActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const sections = projectSections(
    projectId,
    role,
    project?.myTrainingRole ?? null,
  );

  if (collapsed) {
    return (
      <ul
        aria-label={`${name} sections`}
        className="flex flex-col items-center gap-1"
      >
        {sections.map(({ label, href }) => {
          const Icon = SECTION_ICONS[label];
          return (
            <li key={href}>
              <RailLink
                href={href}
                label={label}
                active={isSectionActive(href)}
              >
                <Icon className="size-4" aria-hidden="true" />
              </RailLink>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <div className="text-text-3 truncate px-3 pt-3 pb-1 text-[11px] font-medium tracking-[0.06em] uppercase">
        {name}
      </div>
      <ul aria-label={`${name} sections`} className="flex flex-col gap-0.5">
        {sections.map(({ label, href }) => {
          const Icon = SECTION_ICONS[label];
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isSectionActive(href) ? "page" : undefined}
                className={cn(
                  "text-text-2 hover:bg-hover hover:text-text flex items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] transition-colors",
                  isSectionActive(href) && "bg-brand-bg text-brand-text",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
