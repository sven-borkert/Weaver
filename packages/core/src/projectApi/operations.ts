import { createHash, randomUUID } from "node:crypto";
import type {
  PrismaClient,
  ProjectApiOperation,
  Prisma,
} from "@weaver/db/client";
import type { ProjectRepoWriter } from "@weaver/git-store";
import { CoreError, CORE_ERROR_CODES, type CoreErrorCode } from "../errors";
import { withProjectRepo } from "../services/projectRepo";
import {
  writeDocumentInRepo,
  deleteDocumentInRepo,
  repairDocumentProjectionInRepo,
} from "../services/documents";
import {
  writeTableInRepo,
  deleteTableInRepo,
  repairTableProjectionInRepo,
} from "../services/tables";
import {
  enqueueContentDeleted,
  enqueueTableChanged,
} from "../services/knowledgeReconciliation";
import { notifyProjectContentChanged } from "../services/projectGitRemoteJobs";
import { parseDocumentBody } from "../editor/markdown";
import { extractCrossrefTargets } from "../documents/links";
import { parseDocumentFile } from "../documents/frontmatter";
import { parseSchemaFile } from "../tables/jsonl";
import { requireLiveProjectMachineKey } from "../security/projectMachine";
import type {
  MachineReceipt,
  MutationMeta,
  ProjectMachineContext,
} from "./types";
import { MACHINE_IDEMPOTENCY_KEY_RE } from "./constants";
import { machineCommandSchema, type MachineCommand } from "./schemas";
import {
  prepareMachineChange,
  type GeneratedMachineIds,
  type PreparedMachineChange,
} from "./changes";
import {
  indexedMachineTarget,
  loadMachinePolicy,
  resolveMachineTargetInRepo,
  assertMachineActions,
  type ResolvedMachineTarget,
  type MachinePolicy,
} from "./policy";
import { loadFolderIdentityIndex } from "./folderIdentity";
import {
  resourceIdentityIndex,
  readMachineDocumentSnapshot,
  readMachineTableSnapshot,
} from "./snapshots";
import { withProjectApiOperationLock } from "./operationLock";

export type ProjectApiReservation = ProjectApiOperation;
type Anchors = {
  target: ResolvedMachineTarget;
  actions: PreparedMachineChange["actions"];
  beforeHead: string;
  path: string | null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function requireRevision(ifMatch: string | null, revision: string) {
  if (ifMatch === null)
    throw new CoreError("PRECONDITION_FAILED", "If-Match is required", {
      status: 428,
    });
  if (!/^"[a-f0-9]{40}"$/.test(ifMatch))
    throw new CoreError("BAD_REQUEST", "A single strong If-Match is required");
  if (ifMatch !== `"${revision}"`)
    throw new CoreError("PRECONDITION_FAILED", "Revision changed", {
      status: 412,
    });
}
/** Rejections a retry of the identical request would repeat; anything else is not recorded. */
const DETERMINISTIC_FAILURE_STATUS: Partial<Record<CoreErrorCode, number>> = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PRECONDITION_FAILED: 412,
};
async function reauthorize(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  policy: MachinePolicy,
  reservation: ProjectApiReservation,
  command: MachineCommand,
) {
  const anchors = reservation.authorizingAnchors as unknown as Anchors;
  const kind = command.kind.startsWith("document") ? "document" : "table";
  let current: ResolvedMachineTarget | null = null;
  try {
    current = await resolveMachineTargetInRepo(db, repo, policy.context, {
      kind,
      id: reservation.resourceId!,
    });
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "NOT_FOUND")
      throw error;
  }
  if (current) {
    const target =
      "folder" in command
        ? {
            ...current,
            kind:
              kind === "document"
                ? ("documentFolder" as const)
                : ("tableFolder" as const),
            id: current.ancestors.at(-1) ?? null,
            root: current.path.length === 0,
          }
        : current;
    assertMachineActions(policy, target, anchors.actions);
    return;
  }
  if ("folder" in command) {
    const folder = await resolveMachineTargetInRepo(db, repo, policy.context, {
      kind: kind === "document" ? "documentFolder" : "tableFolder",
      folder: command.folder,
    });
    assertMachineActions(policy, folder, anchors.actions);
    return;
  }
  const index = await loadFolderIdentityIndex(
    repo,
    policy.context.projectId,
    kind === "document" ? "documents" : "tables",
    await repo.resolveHead(),
  );
  assertMachineActions(
    policy,
    {
      ...anchors.target,
      ancestors: anchors.target.ancestors.filter((id) => index.byId.has(id)),
    },
    anchors.actions,
  );
}

async function settle(
  db: PrismaClient,
  reservation: ProjectApiReservation,
  receipt: MachineReceipt,
) {
  await db.projectApiOperation.update({
    where: { id: reservation.id },
    data: {
      state: "succeeded",
      receipt: json({ ...receipt, replayed: false }),
      commitSha: receipt.revision,
      completedAt: new Date(),
      httpStatus: reservation.operation.endsWith(".create") ? 201 : 200,
    },
  });
}
async function repairRecoveredContent(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  context: ProjectMachineContext,
  kind: "document" | "table",
  resourceId: string,
) {
  if (kind === "document") {
    let snapshot;
    try {
      snapshot = await readMachineDocumentSnapshot(
        db,
        repo,
        context.projectId,
        resourceId,
      );
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== "NOT_FOUND")
        throw error;
    }
    if (snapshot) {
      const repaired = await repairDocumentProjectionInRepo(
        db,
        repo,
        context.projectId,
        resourceId,
        snapshot.path,
      );
      if (!repaired)
        throw new CoreError(
          "INTERNAL_SERVER_ERROR",
          "Document projection recovery could not be completed",
        );
      return;
    }
    await db.document.deleteMany({
      where: { projectId: context.projectId, id: resourceId },
    });
  } else {
    let snapshot;
    try {
      snapshot = await readMachineTableSnapshot(
        db,
        repo,
        context.projectId,
        resourceId,
      );
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== "NOT_FOUND")
        throw error;
    }
    if (snapshot) {
      await repairTableProjectionInRepo(
        db,
        repo,
        context.projectId,
        resourceId,
        { throwOnError: true },
      );
      await enqueueTableChanged({
        projectId: context.projectId,
        tableId: resourceId,
        sourceCommitSha: snapshot.revision,
        pathAtSha: snapshot.path,
      });
      return;
    }
    await db.dataTable.deleteMany({
      where: { projectId: context.projectId, id: resourceId },
    });
  }
  await enqueueContentDeleted({
    projectId: context.projectId,
    sourceType: kind,
    sourceId: resourceId,
    sourceCommitSha: await repo.resolveHead(),
  });
}

export async function recoverProjectMachineOperation(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  reservation: ProjectApiReservation,
  context: ProjectMachineContext,
  command: MachineCommand,
): Promise<MachineReceipt | null> {
  const anchors = reservation.authorizingAnchors as unknown as Anchors;
  if (!(await repo.isAncestor(anchors.beforeHead, await repo.resolveHead())))
    throw new CoreError("CONFLICT", "Operation needs investigation");
  const entries = await repo.logSince(anchors.beforeHead, { limit: 2001 });
  if (entries.length > 2000)
    throw new CoreError("CONFLICT", "Operation needs investigation");
  const matching = entries.filter(
    (e) => e.operationId === `project-api:${reservation.id}`,
  );
  if (matching.length === 0) return null;
  if (
    matching.length !== 1 ||
    !matching[0]!.trustedAuthor ||
    matching[0]!.projectKeyId !== context.keyId
  )
    throw new CoreError("CONFLICT", "Operation needs investigation");
  const entry = matching[0]!;
  let path: string | null = null;
  for (const change of entry.changes) {
    const log = await repo.logForPath(change.path, {
      skip: 0,
      limit: 1,
      commitish: entry.sha,
    });
    const provenance = log[0];
    if (
      !provenance?.trustedAuthor ||
      provenance.operationId !== `project-api:${reservation.id}` ||
      provenance.apiRequestHash !== reservation.requestHash ||
      provenance.apiOperation !== command.kind ||
      provenance.projectKeyId !== context.keyId
    )
      continue;
    if (command.kind === "document.delete" || command.kind === "table.delete") {
      if (
        change.status === "D" &&
        (change.path === anchors.path ||
          change.path === `${anchors.path}/schema.json`)
      )
        path = anchors.path;
    } else {
      try {
        const file = await repo.readCommittedFileAt(entry.sha, change.path);
        if (!file) continue;
        if (
          command.kind.startsWith("document") &&
          change.path.endsWith(".md") &&
          parseDocumentFile(file.content, "markdown").meta.id ===
            reservation.resourceId
        )
          path = change.path;
        if (
          !command.kind.startsWith("document") &&
          change.path.endsWith("/schema.json") &&
          parseSchemaFile(file.content).id === reservation.resourceId
        )
          path = change.path.slice(0, -12);
      } catch {
        continue;
      }
    }
  }
  if (!path) throw new CoreError("CONFLICT", "Operation needs investigation");
  const ids = reservation.generatedIds as unknown as GeneratedMachineIds;
  const receipt: MachineReceipt = {
    operationId: reservation.id,
    resourceId: ids.resourceId,
    path,
    revision: entry.sha,
    replayed: true,
    ...(ids.columnIds.length || ids.rowIds.length
      ? { generatedIds: { columnIds: ids.columnIds, rowIds: ids.rowIds } }
      : {}),
  };
  await repairRecoveredContent(
    db,
    repo,
    context,
    command.kind.startsWith("document") ? "document" : "table",
    ids.resourceId,
  );
  await settle(db, reservation, receipt);
  return receipt;
}

export async function applyProjectMachineOperation(
  db: PrismaClient,
  context: ProjectMachineContext,
  rawCommand: MachineCommand,
  meta: MutationMeta,
): Promise<MachineReceipt> {
  const parsed = machineCommandSchema.safeParse(rawCommand);
  if (!parsed.success || !MACHINE_IDEMPOTENCY_KEY_RE.test(meta.idempotencyKey))
    throw new CoreError("BAD_REQUEST", "Invalid publishing request");
  const command = parsed.data;
  const hash = createHash("sha256")
    .update(
      canonical({
        command,
        method: meta.method,
        projectId: context.projectId,
        ifMatch: meta.ifMatch,
      }),
    )
    .digest("hex");
  return withProjectApiOperationLock(
    `project-api:${context.keyId}:${meta.idempotencyKey}`,
    () =>
      withProjectRepo(context.projectId, async (repo) => {
        const policy = await loadMachinePolicy(db, context, true);
        let reservation = await db.projectApiOperation.findUnique({
          where: {
            keyId_idempotencyKey: {
              keyId: context.keyId,
              idempotencyKey: meta.idempotencyKey,
            },
          },
        });
        if (reservation) {
          if (
            reservation.requestHash !== hash ||
            reservation.projectId !== context.projectId ||
            reservation.operation !== command.kind
          )
            throw new CoreError("CONFLICT", "Idempotency key already used", {
              reason: "IDEMPOTENCY_KEY_REUSED",
            });
          await reauthorize(db, repo, policy, reservation, command);
          if (reservation.state === "succeeded")
            return {
              ...(reservation.receipt as unknown as MachineReceipt),
              replayed: true,
            };
          if (reservation.state === "failed") {
            const recorded = reservation.error as { code?: unknown };
            const code =
              typeof recorded.code === "string" &&
              CORE_ERROR_CODES.includes(recorded.code as CoreErrorCode)
                ? (recorded.code as CoreErrorCode)
                : "INTERNAL_SERVER_ERROR";
            throw new CoreError(code, "Previously failed operation", {
              status: reservation.httpStatus ?? 400,
            });
          }
          const recovered = await recoverProjectMachineOperation(
            db,
            repo,
            reservation,
            policy.context,
            command,
          );
          if (recovered) {
            await notifyProjectContentChanged(db, context.projectId);
            return recovered;
          }
        }
        if (meta.signal?.aborted)
          throw new CoreError("BAD_REQUEST", "Request cancelled");
        const creating =
          command.kind === "document.create" || command.kind === "table.create";
        const kind = command.kind.startsWith("document") ? "document" : "table";
        let target: ResolvedMachineTarget;
        if ("folder" in command) {
          target = await resolveMachineTargetInRepo(db, repo, policy.context, {
            kind: kind === "document" ? "documentFolder" : "tableFolder",
            folder: command.folder,
          });
        } else {
          const head = await repo.resolveHead();
          const path = (
            await resourceIdentityIndex(repo, context.projectId, kind, head)
          ).get(command.id);
          if (!path) throw new CoreError("NOT_FOUND");
          target = indexedMachineTarget(
            kind,
            command.id,
            path,
            await loadFolderIdentityIndex(
              repo,
              context.projectId,
              kind === "document" ? "documents" : "tables",
              head,
            ),
          );
        }
        assertMachineActions(policy, target, [
          creating || command.kind === "rows.append"
            ? "create"
            : command.kind.endsWith(".delete")
              ? "delete"
              : "update",
        ]);
        const current = creating
          ? null
          : kind === "document"
            ? await readMachineDocumentSnapshot(
                db,
                repo,
                context.projectId,
                (command as { id: string }).id,
              )
            : await readMachineTableSnapshot(
                db,
                repo,
                context.projectId,
                (command as { id: string }).id,
              );
        const ids: GeneratedMachineIds = reservation
          ? (reservation.generatedIds as unknown as GeneratedMachineIds)
          : {
              resourceId: "id" in command ? command.id : randomUUID(),
              columnIds:
                command.kind === "table.create"
                  ? command.columns.map((c) => c.id ?? randomUUID())
                  : [],
              rowIds:
                command.kind === "table.create" ||
                command.kind === "rows.append"
                  ? command.rows.map((r) => r.id ?? randomUUID())
                  : [],
              createdAt: new Date().toISOString(),
            };
        const change = prepareMachineChange(command, current, ids);
        assertMachineActions(policy, target, change.actions);
        if (current) requireRevision(meta.ifMatch, current.revision);
        await validateReferences(db, repo, policy, change, current);
        const anchors: Anchors = {
          target,
          actions: change.actions,
          beforeHead: await repo.resolveHead(),
          path: current?.path ?? null,
        };
        reservation ??= await db.projectApiOperation.create({
          data: {
            keyId: context.keyId,
            projectId: context.projectId,
            idempotencyKey: meta.idempotencyKey,
            operation: command.kind,
            requestHash: hash,
            resourceId: ids.resourceId,
            generatedIds: json(ids),
            authorizingAnchors: json(anchors),
            createdAt: new Date(),
          },
        });
        const actor = {
          kind: "projectApiKey" as const,
          machineId: context.keyId,
          projectId: context.projectId,
          name: policy.context.name,
          email: `project-key-${context.keyId}@weaver.invalid`,
        };
        const audit = {
          operationId: `project-api:${reservation.id}`,
          apiRequestHash: hash,
          apiOperation: command.kind,
        };
        const commit = repo.commitAll.bind(repo);
        const guarded = {
          ...repo,
          commitAll: async (...args: Parameters<typeof commit>) => {
            args[2] = {
              ...args[2],
              beforeCommit: async () => {
                if (meta.signal?.aborted)
                  throw new CoreError("BAD_REQUEST", "Request cancelled");
                await requireLiveProjectMachineKey(
                  db,
                  context.keyId,
                  context.projectId,
                );
              },
            };
            return commit(...args);
          },
        };
        let result: { id: string; path: string; headCommitSha: string };
        try {
          if (command.kind === "document.replace")
            await repairDocumentProjectionInRepo(
              db,
              repo,
              context.projectId,
              command.id,
              current!.path,
            );
          if (command.kind === "document.delete") {
            await repairDocumentProjectionInRepo(
              db,
              repo,
              context.projectId,
              command.id,
              current!.path,
            );
            result = await deleteDocumentInRepo(
              db,
              guarded,
              { projectId: context.projectId, documentId: command.id },
              actor,
              audit,
            );
          } else if (command.kind === "table.delete")
            result = await deleteTableInRepo(
              db,
              guarded,
              {
                projectId: context.projectId,
                tableId: command.id,
                expectedHeadCommitSha: current!.revision,
              },
              actor,
              audit,
            );
          else if (command.kind === "document.create")
            result = await writeDocumentInRepo(
              db,
              guarded,
              context.projectId,
              {
                kind: "create",
                id: ids.resourceId,
                title: command.title,
                folderPath: target.path,
                content: {
                  kind: "markdown",
                  contentJson: parseDocumentBody(change.markdown!),
                },
                createdAt: ids.createdAt,
              },
              actor,
              { operation: "create", ...audit },
            );
          else if (command.kind === "document.replace")
            result = await writeDocumentInRepo(
              db,
              guarded,
              context.projectId,
              {
                kind: "update",
                documentId: command.id,
                baseCommitSha: current!.revision,
                title: command.title,
                content: {
                  kind: "markdown",
                  contentJson: parseDocumentBody(change.markdown!),
                },
                changeSummary: "Project API update",
              },
              actor,
              { operation: "update", ...audit },
            );
          else
            result = await writeTableInRepo(
              db,
              guarded,
              context.projectId,
              command.kind === "table.create"
                ? {
                    kind: "create",
                    id: ids.resourceId,
                    title: command.title,
                    folderPath: target.path,
                    columns: change.columns!,
                    rows: change.rows!,
                    createdAt: ids.createdAt,
                  }
                : {
                    kind: "update",
                    tableId: (command as { id: string }).id,
                    baseCommitSha: current!.revision,
                    ...(command.kind === "table.replace"
                      ? { title: command.title }
                      : {}),
                    columns: change.columns!,
                    rows: change.rows!,
                  },
              actor,
              { operation: creating ? "create" : "update", ...audit },
            );
        } catch (error) {
          if ((await repo.resolveHead()) === anchors.beforeHead) {
            await repo.resetWorktreeTo(anchors.beforeHead);
            const status =
              error instanceof CoreError && !meta.signal?.aborted
                ? DETERMINISTIC_FAILURE_STATUS[error.code]
                : undefined;
            // No commit exists: a transient failure leaves the key free for a plain retry.
            if (status === undefined)
              await db.projectApiOperation.delete({
                where: { id: reservation.id },
              });
            else
              await db.projectApiOperation.update({
                where: { id: reservation.id },
                data: {
                  state: "failed",
                  error: json({ code: (error as CoreError).code }),
                  httpStatus: status,
                  completedAt: new Date(),
                },
              });
          }
          throw error;
        }
        const receipt: MachineReceipt = {
          resourceId: result.id,
          path: result.path,
          revision: result.headCommitSha,
          operationId: reservation.id,
          replayed: false,
          ...(ids.columnIds.length || ids.rowIds.length
            ? { generatedIds: { columnIds: ids.columnIds, rowIds: ids.rowIds } }
            : {}),
        };
        try {
          await settle(db, reservation, receipt);
        } catch {
          // The commit stands; a retry with the same key recovers this receipt.
          throw new CoreError(
            "INTERNAL_SERVER_ERROR",
            "The write was saved but its receipt is not confirmed yet",
            {
              reason: "RECEIPT_PENDING",
              operationId: reservation.id,
              resourceId: receipt.resourceId,
              commitSha: receipt.revision,
            },
          );
        }
        await notifyProjectContentChanged(db, context.projectId);
        return receipt;
      }),
  );
}
async function validateReferences(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  policy: MachinePolicy,
  change: PreparedMachineChange,
  current:
    | Awaited<ReturnType<typeof readMachineDocumentSnapshot>>
    | Awaited<ReturnType<typeof readMachineTableSnapshot>>
    | null,
) {
  const refs: { kind: "document" | "table"; id: string }[] = [];
  if (change.markdown !== undefined) {
    const prior =
      current?.kind === "document"
        ? extractCrossrefTargets(parseDocumentBody(current.markdown))
        : [];
    for (const ref of extractCrossrefTargets(
      parseDocumentBody(change.markdown),
    ))
      if (
        !prior.some(
          (p) => p.targetId === ref.targetId && p.targetType === ref.targetType,
        )
      )
        refs.push({ kind: ref.targetType, id: ref.targetId });
  }
  for (const column of change.columns ?? [])
    if (column.type === "document")
      for (const row of change.rows ?? []) {
        const value = row.cells[column.id];
        if (typeof value !== "string") continue;
        const previous =
          current?.kind === "table"
            ? current.rows.find((r) => r.id === row.id)?.cells[column.id]
            : undefined;
        const previousType =
          current?.kind === "table"
            ? current.columns.find((c) => c.id === column.id)?.type
            : undefined;
        if (value !== previous || previousType !== "document")
          refs.push({ kind: "document", id: value });
      }
  for (const ref of refs)
    assertMachineActions(
      policy,
      await resolveMachineTargetInRepo(db, repo, policy.context, ref),
      ["read"],
    );
}
