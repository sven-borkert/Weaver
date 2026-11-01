import { z } from "zod";
import { CoreError } from "../errors";

// Browser-safe half of the assistant scope contract: no database, Git, or
// service imports. Client components must import from here, not from scope.ts.

export const SCOPE_VIOLATION = "SCOPE_VIOLATION";

/** Hard cap on a snapshot's project list; `all` clamps to it rather than refusing. */
export const MAX_SCOPE_PROJECTS = 100;

/** Mirrors the Git folder-slug rule (contentOperations.folderPath), kept here to stay browser-safe. */
export const scopeFolderPathSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/))
  .min(1)
  .max(10);

export const scopeRequestSchema = z.discriminatedUnion("kind", [
  // A focus inside one project, like document/table: project membership stays the boundary.
  z.object({
    kind: z.literal("folder"),
    projectId: z.uuid(),
    resourceType: z.enum(["document", "table"]),
    folderPath: scopeFolderPathSchema,
  }),
  z.object({
    kind: z.literal("document"),
    projectId: z.uuid(),
    documentId: z.uuid(),
  }),
  z.object({
    kind: z.literal("table"),
    projectId: z.uuid(),
    tableId: z.uuid(),
  }),
  z.object({ kind: z.literal("project"), projectId: z.uuid() }),
  z.object({
    kind: z.literal("projects"),
    projectIds: z.array(z.uuid()).min(1).max(MAX_SCOPE_PROJECTS),
  }),
  z.object({ kind: z.literal("all") }),
]);
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;

export const scopeSnapshotSchema = z.object({
  kind: z.enum(["document", "table", "folder", "project", "projects", "all"]),
  projectIds: z.array(z.uuid()).max(MAX_SCOPE_PROJECTS),
  documentId: z.uuid().nullable(),
  tableId: z.uuid().nullable(),
  // Present only on a folder focus, so every other snapshot keeps its stored shape and digest.
  folderPath: scopeFolderPathSchema.nullish(),
  folderResourceType: z.enum(["document", "table"]).nullish(),
  resolvedAt: z.iso.datetime(),
  // Snapshots stored before the cap existed parse without it.
  truncated: z.boolean().default(false),
});
export type ScopeSnapshot = z.infer<typeof scopeSnapshotSchema>;

export function assertInScope(scope: ScopeSnapshot, projectId: string): void {
  if (!scope.projectIds.includes(projectId)) {
    throw new CoreError("FORBIDDEN", SCOPE_VIOLATION, {
      reason: SCOPE_VIOLATION,
    });
  }
}
