import { projectRoleAtLeast, type ProjectRoleName } from "@weaver/core/roles";

const SECTION_ROUTE =
  /^\/projects\/[^/]+\/(documents|tables|graph|imports|tasks|activity|settings)(?:\/([^/?]+))?/;

/** Same section on the new project; an open item or a non-section page lands on Documents. */
export function projectSwitchDestination(
  pathname: string,
  targetProjectId: string,
  targetRole: ProjectRoleName,
): string {
  const base = `/projects/${targetProjectId}`;
  const match = SECTION_ROUTE.exec(pathname);
  if (!match) return `${base}/documents`;
  const [, section, item] = match;
  if (section === "documents" && item) return `${base}/documents`;
  if (section === "imports" && !projectRoleAtLeast(targetRole, "Editor"))
    return `${base}/documents`;
  return `${base}/${section}`;
}

export const PROJECT_FILTER_THRESHOLD = 8;

export type SwitchableProject = {
  id: string;
  name: string;
  myRole: ProjectRoleName;
  personalOwnerId?: string | null;
};

/** Case-insensitive name substring match; a blank filter keeps every project in query order. */
export function filterProjects<T extends SwitchableProject>(
  projects: readonly T[],
  filter: string,
): T[] {
  const normalized = filter.trim().toLocaleLowerCase();
  if (!normalized) return [...projects];
  return projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(normalized),
  );
}
