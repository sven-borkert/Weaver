import { createHash } from "node:crypto";
import { parseServerEnv } from "@weaver/config/server";
import type { McpOutcome, PrismaClient } from "@weaver/db/client";
import {
  createAdvisoryLockPool,
  createProjectTurnQueue,
  RepoLockTimeoutError,
  withProjectAdvisoryLock,
  type AdvisoryLockPool,
} from "@weaver/git-store/advisory-lock";
import type { Pool } from "pg";
import { CoreError } from "../errors";
import { hasCapability } from "../security/context";
import {
  applyOperationInRepo,
  checkOperationBase,
  contentOperationSchema,
  findCommitByOperationId,
  recoverPriorOperation,
  type ContentOperation,
} from "./contentOperations";
import type { EnrichedActor } from "./documents";
import { assertProjectRole } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";
import { captureError, emitDiagnostic } from "../diagnostics/writer";

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
export const MCP_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MCP_PRUNE_BATCH_SIZE = 5_000;
const MCP_PRUNE_LOCK = "weaver:mcp-records-prune";

let parsedEnv: ReturnType<typeof parseServerEnv> | undefined;

function serverEnv() {
  return (parsedEnv ??= parseServerEnv(process.env));
}

const globalForMcpOperations = globalThis as typeof globalThis & {
  weaverMcpOperationLockPool?: Pool;
  weaverMcpOperationTurnQueue?: ReturnType<typeof createProjectTurnQueue>;
};

/** A separate pool avoids self-deadlock when the project-lock pool has one connection. */
function mcpOperationLockPool(): AdvisoryLockPool {
  const env = serverEnv();
  return (globalForMcpOperations.weaverMcpOperationLockPool ??=
    createAdvisoryLockPool({
      connectionString: env.DATABASE_URL,
      max: env.WEAVER_MCP_OPERATION_LOCK_POOL_MAX,
      applicationName: "weaver-mcp-operation-lock",
      onError: (error) => {
        const reference = captureError({
          event: "runtime.error",
          message: "MCP operation-lock pool error",
          error,
          details: { source: "mcp-operation-lock" },
        });
        console.error(
          `weaver MCP operation-lock pool error (ref ${reference ?? "none"})`,
        );
      },
    }));
}

function mcpOperationTurnQueue() {
  return (globalForMcpOperations.weaverMcpOperationTurnQueue ??=
    createProjectTurnQueue());
}

async function withMcpOperationLock<T>(
  operationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const env = serverEnv();
  const lockId = `mcp-operation:${operationId}`;
  const deadline = Date.now() + env.WEAVER_GIT_LOCK_TIMEOUT_MS;
  try {
    // The local queue saves pool slots; PostgreSQL serializes across processes.
    return await mcpOperationTurnQueue().withTurn(lockId, deadline, () =>
      withProjectAdvisoryLock(
        mcpOperationLockPool(),
        lockId,
        {
          timeoutMs: Math.max(1, deadline - Date.now()),
          onUnlockError: (error) => {
            const reference = captureError({
              event: "runtime.error",
              message: "MCP operation unlock failed",
              error,
              details: { source: "mcp-operation-unlock", operationId },
            });
            console.error(
              `MCP operation unlock failed: ${operationId} (ref ${reference ?? "none"})`,
            );
          },
        },
        fn,
      ),
    );
  } catch (error) {
    if (error instanceof RepoLockTimeoutError) {
      throw new CoreError("CONFLICT", "MCP operation is busy", {
        retryable: true,
        reason: "BUSY",
        retryAfterMs: 1000,
      });
    }
    throw error;
  }
}

/** JSON with recursively sorted object keys, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function requestHash(input: unknown): string {
  return sha256(canonicalJson(input));
}

/** Weaver-Operation-Id trailer for a direct write; derivable before any row exists. */
export function mcpOperationId(userId: string, idempotencyKey: string): string {
  return `mcp:${sha256(`${userId}:${idempotencyKey}`).slice(0, 32)}`;
}

export type McpWriteResult = {
  projectId: string;
  resourceId: string | null;
  path: string;
  commitSha: string;
  replayed: boolean;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

async function awaitWhileWriteIsCancellable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  irreversibleStarted: () => boolean,
): Promise<T> {
  if (!signal) return work;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (!irreversibleStarted()) reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function existingResourceId(operation: ContentOperation): string | null {
  switch (operation.kind) {
    case "document.edit":
    case "document.patch":
      return operation.documentId;
    case "table.schema":
    case "table.rows":
    case "table.change":
      return operation.tableId;
    case "content.restore":
      return operation.resourceId;
    case "content.lifecycle":
      // A folder action commits no resource, so this is null for one; an
      // item action always carries an id.
      return operation.resourceId ?? null;
    default:
      return null;
  }
}

/**
 * Spec §16/§26.2 item 11: one commit per (user, idempotency key). Inside the
 * user/key lock: replay a stored result, refuse a reused key, then take the
 * project lock, check the base revision (recovering our own earlier commit by
 * trailer), apply, and store the result before releasing the outer lock.
 */
export async function applyMcpOperation(
  db: PrismaClient,
  actor: EnrichedActor,
  input: {
    idempotencyKey: string;
    toolName: string;
    operation: ContentOperation;
    summary: string;
    signal?: AbortSignal;
  },
): Promise<McpWriteResult> {
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey))
    throw new CoreError("BAD_REQUEST", "invalid idempotency key", {
      field: "idempotencyKey",
    });
  const summary = input.summary.trim();
  if (
    summary.length === 0 ||
    summary.length > 500 ||
    /[\x00-\x1f\x7f]/.test(input.summary)
  )
    throw new CoreError("BAD_REQUEST", "summary is required", {
      field: "summary",
    });
  const operation = contentOperationSchema.parse(input.operation);
  if (!hasCapability(actor, "content:write")) throw new CoreError("FORBIDDEN");
  input.signal?.throwIfAborted();
  await assertProjectRole(db, operation.projectId, actor, "Editor");
  input.signal?.throwIfAborted();
  const hash = requestHash({ toolName: input.toolName, operation, summary });
  const operationId = mcpOperationId(actor.userId, input.idempotencyKey);
  const where = {
    userId_idempotencyKey: {
      userId: actor.userId,
      idempotencyKey: input.idempotencyKey,
    },
  };

  let irreversibleStarted = false;
  let committed = false;
  const work = withMcpOperationLock(operationId, () =>
    withProjectRepo(operation.projectId, async (repo) => {
      input.signal?.throwIfAborted();
      const existing = await db.mcpOperation.findUnique({ where });
      if (existing) {
        if (existing.requestHash !== hash)
          throw new CoreError(
            "CONFLICT",
            "idempotency key was already used for a different request",
            { reason: "IDEMPOTENCY_KEY_REUSED" },
          );
        return {
          ...(existing.result as Omit<McpWriteResult, "replayed">),
          replayed: true,
        };
      }

      const recoveredCreate = await recoverPriorOperation(
        db,
        repo,
        operation,
        operationId,
        { requestHash: hash, toolName: input.toolName },
      );
      const base = await checkOperationBase(db, repo, operation);
      input.signal?.throwIfAborted();
      let applied: {
        commitSha: string;
        resourceId: string | null;
        path: string;
      };
      if (recoveredCreate) {
        applied = recoveredCreate;
      } else if (!base.ok) {
        if (base.reason === "gone")
          throw new CoreError("NOT_FOUND", "target no longer exists");
        // Our own commit from a crash between commit and row insert wins;
        // anything else is a real conflict the client must re-read for.
        const recovered = await findCommitByOperationId(
          repo,
          base.path,
          operationId,
          { requestHash: hash, toolName: input.toolName },
        );
        if (!recovered) {
          const unverified = await findCommitByOperationId(
            repo,
            base.path,
            operationId,
          );
          if (unverified)
            throw new CoreError(
              "CONFLICT",
              "idempotency key was already used for a different request, or its prior commit cannot be verified",
              { reason: "IDEMPOTENCY_KEY_REUSED" },
            );
          throw new CoreError(
            "CONFLICT",
            "base revision changed; re-read and retry with the current commitSha",
            { reason: "STALE_BASE" },
          );
        }
        applied = {
          commitSha: recovered,
          resourceId: existingResourceId(operation),
          path: base.path,
        };
      } else {
        input.signal?.throwIfAborted();
        irreversibleStarted = true;
        applied = await applyOperationInRepo(db, repo, operation, actor, {
          table: base.table,
          summary,
          operationId,
          mcpRequestHash: hash,
          mcpToolName: input.toolName,
          message: (path) => `mcp: ${path} — ${summary}`,
        });
        committed = true;
      }

      const result = {
        projectId: operation.projectId,
        resourceId: applied.resourceId,
        path: applied.path,
        commitSha: applied.commitSha,
      };
      if (!irreversibleStarted) input.signal?.throwIfAborted();
      await db.mcpOperation.create({
        data: {
          userId: actor.userId,
          credentialId: actor.credentialId,
          projectId: operation.projectId,
          idempotencyKey: input.idempotencyKey,
          toolName: input.toolName,
          requestHash: hash,
          resourceId: applied.resourceId,
          commitSha: applied.commitSha,
          result,
        },
      });
      return { ...result, replayed: false };
    }),
  );
  const result = await awaitWhileWriteIsCancellable(
    work,
    input.signal,
    () => irreversibleStarted,
  );
  // The dispatch takes the repository's shared read lock, so it must run
  // after withProjectRepo released the write lock (M4).
  if (committed) void notifyProjectContentChanged(db, operation.projectId);
  return result;
}

export type McpAuditInput = {
  requestId: string;
  userId: string | null;
  credentialId: string;
  authenticationMethod: string;
  clientId: string | null;
  method: string;
  name: string;
  projectId: string | null;
  outcome: McpOutcome;
  errorCode: string | null;
  durationMs: number;
  commitSha: string | null;
};

function isProjectForeignKeyViolation(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: string }).code !== "P2003"
  ) {
    return false;
  }
  const meta = (
    error as {
      meta?: {
        field_name?: unknown;
        target?: unknown;
        driverAdapterError?: {
          cause?: {
            constraint?: { index?: unknown; fields?: unknown };
          };
        };
      };
    }
  ).meta;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  const candidates = [meta?.field_name, meta?.target, constraint?.index];
  const fields = constraint?.fields;
  if (Array.isArray(fields)) {
    for (const field of fields as unknown[]) candidates.push(field);
  }
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      (candidate === "projectId" ||
        candidate.includes("McpAuditEvent_projectId_fkey")),
  );
}

/** Spec §17: never payloads, never tokens. A failed insert is logged, never thrown. */
export async function recordMcpAudit(
  db: PrismaClient,
  event: McpAuditInput,
): Promise<void> {
  try {
    await db.mcpAuditEvent.create({
      data: { ...event, name: event.name.slice(0, 500) },
    });
    return;
  } catch (error) {
    if (event.projectId && isProjectForeignKeyViolation(error)) {
      try {
        await db.mcpAuditEvent.create({
          data: { ...event, name: event.name.slice(0, 500), projectId: null },
        });
        return;
      } catch (retryError) {
        error = retryError;
      }
    }
    const reference = captureError({
      event: "runtime.error",
      message: "mcp audit insert failed",
      error,
      requestId: event.requestId,
      details: { source: "mcp-audit" },
    });
    console.error(
      `mcp audit insert failed for request ${event.requestId} (ref ${reference ?? "none"})`,
    );
  }
}

export async function pruneMcpRecords(
  db: PrismaClient,
  now = new Date(),
): Promise<{ operations: number; audits: number }> {
  const operationCutoff = new Date(
    now.getTime() - MCP_OPERATION_RETENTION_MS,
  ).toISOString();
  const auditCutoff = new Date(
    now.getTime() - MCP_AUDIT_RETENTION_MS,
  ).toISOString();
  const result = await db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${MCP_PRUNE_LOCK})) AS locked`;
      if (!lock?.locked) return { operations: 0, audits: 0 };
      const operations = await tx.$executeRaw`
      WITH expired AS (
        SELECT id FROM "McpOperation"
        WHERE "createdAt" < (${operationCutoff}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "createdAt", id LIMIT ${MCP_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "McpOperation" record USING expired
      WHERE record.id = expired.id`;
      const audits = await tx.$executeRaw`
      WITH expired AS (
        SELECT id FROM "McpAuditEvent"
        WHERE "createdAt" < (${auditCutoff}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "createdAt", id LIMIT ${MCP_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "McpAuditEvent" record USING expired
      WHERE record.id = expired.id`;
      return { operations, audits };
    },
    { timeout: 30_000 },
  );
  if (result.operations > 0 || result.audits > 0)
    emitDiagnostic({
      event: "mcp.records.pruned",
      message: "Expired MCP operation and audit records pruned",
      details: result,
    });
  return result;
}
