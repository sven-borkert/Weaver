import { CoreError } from "@weaver/core/errors";
import type { ProjectRoleName } from "@weaver/core/roles";

export const CAPABILITIES = [
  "assistant:use",
  "mcp:use",
  "content:read",
  "content:propose",
  "content:write",
  "llm:admin",
  "system:admin",
  "ingest:external",
  "external:use",
  "external:manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

import type { GlobalRole } from "@weaver/auth/constants";
export type { GlobalRole } from "@weaver/auth/constants";
export type AuthenticationMethod = "session" | "oauth" | "apiKey" | "task";

/** Immutable per-request credential view (spec §7). */
export type SecurityContext = {
  readonly userId: string;
  readonly globalRole: GlobalRole;
  readonly authenticationMethod: AuthenticationMethod;
  readonly credentialId: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly allowedProjectIds: "all-accessible" | ReadonlySet<string>;
};

const SESSION_CAPABILITIES: readonly Capability[] = [
  "assistant:use",
  "content:read",
  "content:propose",
  "content:write",
  "external:manage",
];

export function createSessionSecurityContext(input: {
  userId: string;
  globalRole: GlobalRole;
  sessionId: string;
}): SecurityContext {
  const capabilities = new Set<Capability>(SESSION_CAPABILITIES);
  if (input.globalRole === "Admin") {
    capabilities.add("llm:admin");
    capabilities.add("system:admin");
  }
  return Object.freeze({
    userId: input.userId,
    globalRole: input.globalRole,
    authenticationMethod: "session",
    credentialId: input.sessionId,
    capabilities,
    allowedProjectIds: "all-accessible",
  });
}

const TASK_CAPABILITIES: readonly Capability[] = [
  "content:read",
  "content:write",
];

/** A scheduled task run acting for its owner (Phase 6A §7): content read and write, never admin or assistant capabilities. */
export function createTaskSecurityContext(input: {
  userId: string;
  globalRole: GlobalRole;
  runId: string;
}): SecurityContext {
  return Object.freeze({
    userId: input.userId,
    globalRole: input.globalRole,
    authenticationMethod: "task",
    credentialId: `task-run:${input.runId}`,
    capabilities: new Set<Capability>(TASK_CAPABILITIES),
    allowedProjectIds: "all-accessible",
  });
}

export function hasCapability(
  context: SecurityContext,
  capability: Capability,
): boolean {
  return context.capabilities.has(capability);
}

export function mayAccessProject(
  context: SecurityContext,
  projectId: string,
): boolean {
  return (
    context.allowedProjectIds === "all-accessible" ||
    context.allowedProjectIds.has(projectId)
  );
}

export function requiredCapabilityForRole(min: ProjectRoleName): Capability {
  return min === "Viewer" ? "content:read" : "content:write";
}

/** Capabilities a personal API key may carry (spec §8; system:admin per the diagnostics design §3; ingest:external per the Phase 5 design §8). */
export const API_KEY_CAPABILITIES = [
  "mcp:use",
  "content:read",
  "content:propose",
  "content:write",
  "system:admin",
  "ingest:external",
  "external:use",
  "external:manage",
] as const satisfies readonly Capability[];
export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/** Every key carries these (spec §8: read-only + MCP by default). */
export const DEFAULT_API_KEY_CAPABILITIES = [
  "mcp:use",
  "content:read",
] as const satisfies readonly ApiKeyCapability[];

/** OAuth clients never receive system administration (diagnostics design §3.1). */
export const OAUTH_CAPABILITIES = [
  "mcp:use",
  "content:read",
  "content:propose",
  "content:write",
  "external:use",
  "external:manage",
] as const satisfies readonly Capability[];

import type { OAUTH_SCOPES } from "@weaver/auth/constants";
export { OAUTH_SCOPES } from "@weaver/auth/constants";
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

function isOAuthCapability(value: string): value is Capability {
  return (OAUTH_CAPABILITIES as readonly string[]).includes(value);
}

/** Better Auth api-key permission statements: resource → actions. */
export type ApiKeyPermissions = Record<string, string[]>;

function isApiKeyCapability(value: string): value is ApiKeyCapability {
  return (API_KEY_CAPABILITIES as readonly string[]).includes(value);
}

export function apiKeyPermissionsFromCapabilities(
  capabilities: Iterable<string>,
): ApiKeyPermissions {
  const granted = new Set<ApiKeyCapability>(DEFAULT_API_KEY_CAPABILITIES);
  for (const capability of capabilities) {
    if (isApiKeyCapability(capability)) granted.add(capability);
  }
  const permissions: ApiKeyPermissions = {};
  for (const capability of API_KEY_CAPABILITIES) {
    if (!granted.has(capability)) continue;
    const [resource, action] = capability.split(":") as [string, string];
    (permissions[resource] ??= []).push(action);
  }
  return permissions;
}

export function capabilitiesFromApiKeyPermissions(
  permissions: ApiKeyPermissions | null | undefined,
): Set<Capability> {
  const capabilities = new Set<Capability>(DEFAULT_API_KEY_CAPABILITIES);
  for (const [resource, actions] of Object.entries(permissions ?? {})) {
    for (const action of actions) {
      const capability = `${resource}:${action}`;
      if (isApiKeyCapability(capability)) capabilities.add(capability);
    }
  }
  return capabilities;
}

export function capabilitiesFromScopes(
  scope: string | readonly string[] | undefined,
): Set<Capability> {
  const scopes =
    typeof scope === "string"
      ? scope.split(" ").filter(Boolean)
      : (scope ?? []);
  const capabilities = new Set<Capability>();
  for (const value of scopes) {
    if (isOAuthCapability(value)) capabilities.add(value);
  }
  return capabilities;
}

export function createApiKeySecurityContext(input: {
  userId: string;
  globalRole: GlobalRole;
  keyId: string;
  permissions: ApiKeyPermissions | null | undefined;
  projectIds: readonly string[];
}): SecurityContext {
  const capabilities = capabilitiesFromApiKeyPermissions(input.permissions);
  if (capabilities.has("system:admin")) {
    // Fail closed: the grant survives on the key row, the effect does not survive a demotion.
    if (input.globalRole === "Admin") capabilities.add("llm:admin");
    else capabilities.delete("system:admin");
  }
  return Object.freeze({
    userId: input.userId,
    globalRole: input.globalRole,
    authenticationMethod: "apiKey",
    credentialId: input.keyId,
    capabilities,
    allowedProjectIds:
      input.projectIds.length === 0
        ? "all-accessible"
        : new Set(input.projectIds),
  });
}

export function assertSystemAdmin(context: SecurityContext): void {
  if (!hasCapability(context, "system:admin")) {
    throw new CoreError("FORBIDDEN", "System administration required");
  }
}

export function createOAuthSecurityContext(input: {
  userId: string;
  globalRole: GlobalRole;
  tokenId: string;
  scopes: string | readonly string[];
}): SecurityContext {
  return Object.freeze({
    userId: input.userId,
    globalRole: input.globalRole,
    authenticationMethod: "oauth",
    credentialId: input.tokenId,
    capabilities: capabilitiesFromScopes(input.scopes),
    allowedProjectIds: "all-accessible",
  });
}
