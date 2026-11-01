import { CoreError } from "./errors";

export const PROJECT_ROLE_NAMES = [
  "Owner",
  "Maintainer",
  "Editor",
  "Viewer",
] as const;
export type ProjectRoleName = (typeof PROJECT_ROLE_NAMES)[number];

export const PROJECT_ROLE_RANK: Record<ProjectRoleName, number> = {
  Owner: 4,
  Maintainer: 3,
  Editor: 2,
  Viewer: 1,
};

export function projectRoleAtLeast(
  role: ProjectRoleName,
  min: ProjectRoleName,
): boolean {
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[min];
}

// Better Auth organization member roles (spec §6.1): static, one-to-one.
export const ORGANIZATION_ROLE_BY_PROJECT_ROLE = {
  Owner: "owner",
  Maintainer: "maintainer",
  Editor: "editor",
  Viewer: "viewer",
} as const satisfies Record<ProjectRoleName, string>;
export type OrganizationRole =
  (typeof ORGANIZATION_ROLE_BY_PROJECT_ROLE)[ProjectRoleName];

export function toOrganizationRole(role: ProjectRoleName): OrganizationRole {
  return ORGANIZATION_ROLE_BY_PROJECT_ROLE[role];
}

export function fromOrganizationRole(role: string): ProjectRoleName {
  for (const name of PROJECT_ROLE_NAMES) {
    if (ORGANIZATION_ROLE_BY_PROJECT_ROLE[name] === role) return name;
  }
  // A bad stored Member.role must not crash callers that map it (e.g. project.list).
  throw new CoreError(
    "INTERNAL_SERVER_ERROR",
    `Unknown organization member role: ${role}`,
  );
}
