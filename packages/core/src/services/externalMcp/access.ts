import { loadRuntimeCatalog } from "./capacity";
import { ASSISTANT_RUN_TIMEOUT_MS } from "../../assistant/limits";
import { z } from "zod";
import type { Prisma, PrismaClient, ExternalMcpTool } from "@weaver/db/client";
import { parseToolDefinitions, validateArguments } from "@weaver/external-mcp";
import {
  actorSnapshotSchema,
  deserializeSecurityContext,
} from "../../assistant/actor";
import {
  scopeSnapshotSchema,
  type ScopeSnapshot,
} from "../../assistant/scopeSchema";
import { externalToolSnapshotsSchema } from "../../externalMcp/schema";
import { canonicalDigest } from "../../externalMcp/digest";
import { assertExternalHistoryScope } from "../../externalMcp/historyScope";
import type {
  AuthorizedExternalCall,
  AvailableExternalTool,
  ExternalInvocation,
} from "../../externalMcp/types";
import { CoreError } from "../../errors";
import {
  hasCapability,
  mayAccessProject,
  type SecurityContext,
} from "../../security/context";
import { assertProjectRole, notDeleted } from "../projectAccess";
import {
  requireOwnedConversation,
  toMessageView,
} from "../assistantConversations";

export type ExternalAccessDeps = {
  db: PrismaClient | Prisma.TransactionClient;
  now: () => Date;
};
export { externalToolSnapshotsSchema } from "../../externalMcp/schema";

async function assertPrincipal(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  mcp = false,
) {
  const method = actor.authenticationMethod;
  if (method === "apiKey" || method === "oauth") {
    if (
      !mcp ||
      !hasCapability(actor, "mcp:use") ||
      !hasCapability(actor, "external:use")
    )
      throw new CoreError("FORBIDDEN");
  } else if (mcp || (method !== "session" && method !== "task"))
    throw new CoreError("FORBIDDEN");
  const now = deps.now();
  const user = await deps.db.user.findUnique({
    where: { id: actor.userId },
    select: { banned: true, banExpires: true, mustChangePassword: true },
  });
  if (
    !user ||
    user.mustChangePassword ||
    (user.banned && (!user.banExpires || user.banExpires > now))
  )
    throw new CoreError("UNAUTHORIZED");
  if (actor.authenticationMethod === "session") {
    const session = await deps.db.session.findFirst({
      where: {
        id: actor.credentialId,
        userId: actor.userId,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!session) throw new CoreError("UNAUTHORIZED");
    if (!hasCapability(actor, "assistant:use"))
      throw new CoreError("FORBIDDEN");
  } else if (actor.authenticationMethod === "task") {
    const id = z.uuid().safeParse(actor.credentialId.replace(/^task-run:/, ""));
    if (!actor.credentialId.startsWith("task-run:") || !id.success)
      throw new CoreError("NOT_FOUND");
    const run = await deps.db.scheduledTaskRun.findFirst({
      where: {
        id: id.data,
        status: "running",
        finishedAt: null,
        leaseExpiresAt: { gt: now },
        task: { ownerId: actor.userId, status: "active" },
      },
      select: { id: true },
    });
    if (!run) throw new CoreError("NOT_FOUND");
  }
}
function parseScope(raw: unknown): ScopeSnapshot {
  const parsed = scopeSnapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new CoreError("FORBIDDEN", "Invalid external tool scope");
  return parsed.data;
}
function assertSameScope(raw: unknown, scope: ScopeSnapshot) {
  const stored = parseScope(raw);
  const normalized = (value: ScopeSnapshot) => ({
    ...value,
    projectIds: [...new Set(value.projectIds)].sort(),
  });
  if (
    canonicalDigest(normalized(stored)) !== canonicalDigest(normalized(scope))
  )
    throw new CoreError(
      "FORBIDDEN",
      "External tool scope does not match its execution owner",
    );
}
async function assertScope(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  scope: ScopeSnapshot,
) {
  if (!scope.projectIds.length)
    throw new CoreError("FORBIDDEN", "External tools require a project scope");
  const projectIds = [...new Set(scope.projectIds)];
  if (projectIds.some((id) => !mayAccessProject(actor, id)))
    throw new CoreError("NOT_FOUND");
  const projects = await deps.db.project.findMany({
    where: { id: { in: projectIds }, ...notDeleted },
    select: {
      organization: {
        select: {
          members: { where: { userId: actor.userId }, select: { role: true } },
        },
      },
    },
  });
  if (
    projects.length !== projectIds.length ||
    projects.some((project) => !project.organization.members.length)
  )
    throw new CoreError("NOT_FOUND");
  if (!hasCapability(actor, "content:read")) throw new CoreError("FORBIDDEN");
}
export function reviewedTool(
  tool: Omit<ExternalMcpTool, "discoveredDefinition">,
) {
  if (
    !tool.enabled ||
    !tool.presentInCatalog ||
    !tool.effect ||
    !tool.reviewDigest ||
    !tool.reviewedDefinition ||
    !tool.reviewedRemoteDigest ||
    tool.reviewedRemoteDigest !== tool.discoveredRemoteDigest
  )
    return null;
  try {
    const definition = parseToolDefinitions([tool.reviewedDefinition])[0];
    if (
      !definition?.supportStatus.available ||
      canonicalDigest(definition) !== tool.reviewedRemoteDigest ||
      canonicalDigest({
        remoteDigest: tool.reviewedRemoteDigest,
        effect: tool.effect,
      }) !== tool.reviewDigest
    )
      return null;
    return definition;
  } catch {
    return null;
  }
}
async function assertHistory(
  deps: ExternalAccessDeps,
  conversationId: string,
  scope: ScopeSnapshot,
  beforePosition?: number,
) {
  const history = await deps.db.assistantMessage.findMany({
    where: {
      conversationId,
      ...(beforePosition === undefined
        ? {}
        : { position: { lte: beforePosition } }),
      status: { in: ["complete", "pending"] },
    },
    orderBy: { position: "asc" },
  });
  assertExternalHistoryScope(history.map(toMessageView), scope);
}
export async function listAvailableExternalTools(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  input: { scope: ScopeSnapshot; conversationId?: string },
): Promise<{
  connections: Array<{ id: string; name: string }>;
  tools: AvailableExternalTool[];
}> {
  await assertPrincipal(deps, actor);
  const scope = parseScope(input.scope);
  await assertScope(deps, actor, scope);
  if (input.conversationId) {
    await requireOwnedConversation(deps.db, actor, input.conversationId);
    await assertHistory(deps, input.conversationId, scope);
  }
  const canWrite = hasCapability(actor, "content:write");
  const rows = await loadRuntimeCatalog(deps.db, actor.userId);
  const connections: Array<{ id: string; name: string }> = [];
  const tools: AvailableExternalTool[] = [];
  for (const connection of rows) {
    const eligible = connection.tools
      .filter((tool) => tool.effect === "read" || canWrite)
      .sort((a, b) => a.remoteName.localeCompare(b.remoteName));
    const available = eligible.flatMap((tool) => {
      const definition = reviewedTool(tool);
      if (
        !definition ||
        !tool.effect ||
        (actor.authenticationMethod === "task" && tool.effect !== "read")
      )
        return [];
      return [
        {
          id: tool.id,
          connectionId: connection.id,
          name: definition.name,
          description: definition.description ?? "",
          effect: tool.effect,
          inputSchema: definition.inputSchema,
          configRevision: connection.revision,
          reviewDigest: tool.reviewDigest!,
        },
      ];
    });
    if (available.length) {
      connections.push({ id: connection.id, name: connection.name });
      tools.push(...available);
    }
  }
  return { connections, tools };
}

export function assertActiveAssistantAttempt(
  attempt: {
    status: string;
    endedAt: Date | null;
    number: number;
    leaseExpiresAt: Date;
    run: {
      status: string;
      cancelRequestedAt: Date | null;
      attemptCount: number;
      startedAt: Date | null;
    };
  },
  now: Date,
): void {
  const run = attempt.run;
  if (
    run.status !== "running" ||
    run.cancelRequestedAt ||
    attempt.status !== "running" ||
    attempt.endedAt ||
    attempt.number !== run.attemptCount ||
    attempt.leaseExpiresAt <= now ||
    !run.startedAt ||
    now.getTime() >= run.startedAt.getTime() + ASSISTANT_RUN_TIMEOUT_MS
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External execution is no longer active",
    );
}

async function bindOwner(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  invocation: ExternalInvocation,
  connectionId: string,
): Promise<{ actor: SecurityContext; outputProjectId?: string }> {
  const { owner } = invocation;
  const now = deps.now();
  if (owner.kind === "mcp") {
    if (
      actor.authenticationMethod !== owner.authenticationMethod ||
      actor.credentialId !== owner.credentialId
    )
      throw new CoreError("NOT_FOUND");
    return { actor };
  }
  if (owner.kind === "assistant") {
    if (actor.authenticationMethod !== "session")
      throw new CoreError("NOT_FOUND");
    const attempt = await deps.db.assistantRunAttempt.findFirst({
      where: { id: owner.attemptId, runId: owner.runId },
      include: {
        run: {
          include: {
            conversation: { select: { ownerId: true } },
            userMessage: true,
          },
        },
      },
    });
    if (attempt?.run.conversation.ownerId !== actor.userId)
      throw new CoreError("NOT_FOUND");
    const run = attempt.run;
    const snapshot = actorSnapshotSchema.safeParse(run.actorSnapshot);
    if (
      !snapshot.success ||
      snapshot.data.userId !== actor.userId ||
      snapshot.data.authenticationMethod !== "session" ||
      snapshot.data.credentialId !== actor.credentialId
    )
      throw new CoreError("NOT_FOUND");
    assertActiveAssistantAttempt(attempt, now);
    assertSameScope(run.scopeSnapshot, invocation.scope);
    const content = z
      .object({ externalToolSnapshots: externalToolSnapshotsSchema })
      .safeParse(run.userMessage.content);
    if (
      !content.success ||
      !content.data.externalToolSnapshots.some(
        (s) =>
          s.connectionId === connectionId &&
          s.toolId === invocation.toolId &&
          s.configRevision === invocation.expectedConfigRevision &&
          s.toolDigest === invocation.expectedToolDigest,
      )
    )
      throw new CoreError(
        "PRECONDITION_FAILED",
        "External tool is not loaded or its configuration changed",
      );
    await assertHistory(
      deps,
      run.conversationId,
      invocation.scope,
      run.userMessage.position,
    );
    return { actor: deserializeSecurityContext(snapshot.data) };
  }
  if (
    actor.authenticationMethod !== "task" ||
    actor.credentialId !== `task-run:${owner.runId}`
  )
    throw new CoreError("NOT_FOUND");
  const run = await deps.db.scheduledTaskRun.findFirst({
    where: { id: owner.runId, task: { ownerId: actor.userId } },
    include: {
      task: { include: { externalInputs: { where: { id: owner.inputId } } } },
    },
  });
  if (!run || run.task.externalInputs[0]?.toolId !== invocation.toolId)
    throw new CoreError("NOT_FOUND");
  if (
    run.status !== "running" ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= now ||
    run.finishedAt ||
    run.task.status !== "active"
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External execution is no longer active",
    );
  assertSameScope(run.task.scopeSnapshot, invocation.scope);
  return { actor, outputProjectId: run.task.outputProjectId };
}

async function authorizeInvocation(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  invocation: ExternalInvocation,
  validate = true,
): Promise<AuthorizedExternalCall> {
  const mcp = invocation.owner.kind === "mcp";
  await assertPrincipal(deps, actor, mcp);
  const scope = parseScope(invocation.scope);
  if (!mcp) await assertScope(deps, actor, scope);
  if (
    !Number.isFinite(invocation.deadline.getTime()) ||
    invocation.deadline <= deps.now()
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External execution deadline elapsed",
    );
  const tool = await deps.db.externalMcpTool.findUnique({
    where: { id: invocation.toolId },
    include: {
      connection: {
        select: {
          id: true,
          name: true,
          enabled: true,
          revision: true,
          ownerId: true,
        },
      },
    },
  });
  if (tool?.connection.ownerId !== actor.userId)
    throw new CoreError("NOT_FOUND");
  const bound = await bindOwner(
    deps,
    actor,
    { ...invocation, scope },
    tool.connectionId,
  );
  if (mcp) {
    if (
      !hasCapability(
        actor,
        tool.effect === "write" ? "content:write" : "content:read",
      )
    )
      throw new CoreError("FORBIDDEN");
  } else {
    await assertScope(deps, bound.actor, scope);
    if (
      tool.effect === "write" &&
      (!hasCapability(actor, "content:write") ||
        !hasCapability(bound.actor, "content:write"))
    )
      throw new CoreError("FORBIDDEN");
  }
  const c = tool.connection;
  const definition = reviewedTool(tool);
  if (
    !c.enabled ||
    !definition ||
    !tool.effect ||
    !tool.reviewDigest ||
    c.revision !== invocation.expectedConfigRevision ||
    tool.reviewDigest !== invocation.expectedToolDigest
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "External tool configuration changed",
    );
  if (bound.outputProjectId) {
    if (tool.effect !== "read") throw new CoreError("FORBIDDEN");
    await assertProjectRole(
      deps.db,
      bound.outputProjectId,
      bound.actor,
      "Editor",
    );
  }
  try {
    if (validate) validateArguments(definition, invocation.arguments);
  } catch {
    throw new CoreError(
      "BAD_REQUEST",
      "External tool arguments do not match the reviewed schema",
    );
  }
  return {
    connectionId: c.id,
    connectionName: c.name,
    toolId: tool.id,
    definition,
    effect: tool.effect,
    configRevision: c.revision,
    reviewedDigest: tool.reviewDigest,
    scopeProjectIds: [...new Set(scope.projectIds)].sort(),
  };
}

export async function authorizeExternalInvocation(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  invocation: ExternalInvocation,
) {
  return authorizeInvocation(deps, actor, invocation);
}
export async function authorizeExternalInvocationContext(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  invocation: Omit<ExternalInvocation, "arguments">,
) {
  return authorizeInvocation(
    deps,
    actor,
    { ...invocation, arguments: {} },
    false,
  );
}
export async function assertExternalApprovalOwner(
  deps: ExternalAccessDeps,
  actor: SecurityContext,
  runId: string,
  scope: ScopeSnapshot,
) {
  await assertPrincipal(deps, actor);
  if (actor.authenticationMethod !== "session")
    throw new CoreError("NOT_FOUND");
  const run = await deps.db.assistantRun.findUnique({
    where: { id: runId },
    include: { conversation: true },
  });
  if (run?.conversation.ownerId !== actor.userId)
    throw new CoreError("NOT_FOUND");
  assertSameScope(run.scopeSnapshot, scope);
  await assertScope(deps, actor, scope);
}
