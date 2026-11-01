import type { PrismaClient } from "@weaver/db/client";
import { CoreError } from "../errors";
import type { SecurityContext } from "../security/context";
import { notDeleted, resolveProjectAccess } from "../services/projectAccess";
import { listContentFolders } from "../services/folders";
import { listProjectsForUser } from "../services/projects";
import {
  MAX_SCOPE_PROJECTS,
  scopeSnapshotSchema,
  type ScopeRequest,
  type ScopeSnapshot,
} from "./scopeSchema";

// Server-side resolution. The schemas and constants live in scopeSchema.ts so
// client components can import them without dragging services into bundles.
export {
  MAX_SCOPE_PROJECTS,
  SCOPE_VIOLATION,
  assertInScope,
  scopeRequestSchema,
  scopeSnapshotSchema,
} from "./scopeSchema";
export type { ScopeRequest, ScopeSnapshot } from "./scopeSchema";

type SnapshotBase = {
  documentId: null;
  tableId: null;
  resolvedAt: string;
  truncated: boolean;
};

async function resolveRaw(
  db: PrismaClient,
  actor: SecurityContext,
  request: ScopeRequest,
  base: SnapshotBase,
): Promise<unknown> {
  switch (request.kind) {
    case "all": {
      const projects = await listProjectsForUser(db, actor);
      // Ordered by updatedAt desc, so clamping keeps the most recently touched.
      return {
        ...base,
        kind: "all",
        projectIds: projects.slice(0, MAX_SCOPE_PROJECTS).map((p) => p.id),
        truncated: projects.length > MAX_SCOPE_PROJECTS,
      };
    }
    case "projects": {
      const projects = await listProjectsForUser(db, actor);
      const accessible = new Set(projects.map((p) => p.id));
      const missing = request.projectIds.filter((id) => !accessible.has(id));
      if (missing.length > 0) throw new CoreError("NOT_FOUND");
      return {
        ...base,
        kind: "projects",
        projectIds: [...new Set(request.projectIds)],
      };
    }
    case "project": {
      await resolveProjectAccess(db, request.projectId, actor);
      return { ...base, kind: "project", projectIds: [request.projectId] };
    }
    case "document": {
      await resolveProjectAccess(db, request.projectId, actor);
      const document = await db.document.findFirst({
        where: { id: request.documentId, projectId: request.projectId },
        select: { id: true },
      });
      if (!document) throw new CoreError("NOT_FOUND");
      return {
        ...base,
        kind: "document",
        projectIds: [request.projectId],
        documentId: document.id,
      };
    }
    case "folder": {
      const listing = await listContentFolders(
        db,
        { projectId: request.projectId, resourceType: request.resourceType },
        actor,
      );
      const wanted = request.folderPath.join("/");
      if (!listing.folders.some((folder) => folder.path.join("/") === wanted))
        throw new CoreError("NOT_FOUND");
      return {
        ...base,
        kind: "folder",
        projectIds: [request.projectId],
        folderPath: request.folderPath,
        folderResourceType: request.resourceType,
      };
    }
    case "table": {
      await resolveProjectAccess(db, request.projectId, actor);
      const table = await db.dataTable.findFirst({
        where: { id: request.tableId, projectId: request.projectId },
        select: { id: true },
      });
      if (!table) throw new CoreError("NOT_FOUND");
      return {
        ...base,
        kind: "table",
        projectIds: [request.projectId],
        tableId: table.id,
      };
    }
  }
}

/** Resolve a request into concrete project/resource ids the actor can access right now (spec §12). */
export async function resolveScopeSnapshot(
  db: PrismaClient,
  actor: SecurityContext,
  request: ScopeRequest,
): Promise<ScopeSnapshot> {
  const base: SnapshotBase = {
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: false,
  };
  // Parsed on the way out so nothing can persist a snapshot leaseRunAttempt
  // would later reject: that throws inside the lease transaction and strands
  // the conversation with a run that can never start or finish.
  return scopeSnapshotSchema.parse(await resolveRaw(db, actor, request, base));
}

// MCP scope is capability-neutral; each operation enforces its own capability.
export async function resolveMcpScopeSnapshot(
  db: PrismaClient,
  actor: SecurityContext,
): Promise<ScopeSnapshot> {
  const projects = await db.project.findMany({
    where: {
      ...notDeleted,
      organization: { members: { some: { userId: actor.userId } } },
      ...(actor.allowedProjectIds === "all-accessible"
        ? {}
        : { id: { in: [...actor.allowedProjectIds] } }),
    },
    select: { id: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: MAX_SCOPE_PROJECTS + 1,
  });
  return scopeSnapshotSchema.parse({
    kind: "all",
    projectIds: projects
      .slice(0, MAX_SCOPE_PROJECTS)
      .map((project) => project.id),
    documentId: null,
    tableId: null,
    resolvedAt: new Date().toISOString(),
    truncated: projects.length > MAX_SCOPE_PROJECTS,
  });
}

/** Intersect a stored snapshot with current membership; losing access takes effect immediately. */
export async function effectiveScope(
  db: PrismaClient,
  actor: SecurityContext,
  snapshot: ScopeSnapshot,
): Promise<ScopeSnapshot> {
  const projects = await listProjectsForUser(db, actor);
  const accessible = new Set(projects.map((p) => p.id));
  // A filter can only shrink the list, so the cap the snapshot was parsed
  // under still holds.
  const projectIds = snapshot.projectIds.filter((id) => accessible.has(id));
  return {
    ...snapshot,
    projectIds,
    documentId: projectIds.length > 0 ? snapshot.documentId : null,
    tableId: projectIds.length > 0 ? snapshot.tableId : null,
    ...(snapshot.kind === "folder" && projectIds.length === 0
      ? { folderPath: null, folderResourceType: null }
      : {}),
  };
}
