import { createHash } from "node:crypto";
import type { PrismaClient } from "@weaver/db/client";
import { z } from "zod";
import { documentKindOfPath } from "../documents/kinds";
import { compileDocumentPatch, applyDocumentPatch } from "../documents/patch";
import { slugify } from "../documents/slug";
import { parseDocumentFile } from "../documents/frontmatter";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { createWikiAgentSecurityContext } from "../security/context";
import { wikiAgentContentAuthor } from "./contentAuthor";
import {
  applyDocumentCreate,
  applyDocumentPatchOperation,
  applyFolderCreate,
  findCommitByOperationId,
  folderPath,
  MAX_MARKDOWN_CHARS,
  patchActionSchema,
  recoverCheckApply,
  sha,
  title,
  type AppliedOperation,
  type ContentOperation,
  type RecoveryIdentity,
} from "./contentOperations";
import {
  checkBudget,
  checkNonOwnedActions,
  measureCreate,
  measurePatch,
  type BudgetDecision,
  type BudgetDelta,
} from "../wiki/budget";
import { parseTrackedTarget, weaverLinkTargets } from "../wiki/agentMarkdown";
import {
  MAX_WIKI_SOURCES,
  normalizeProperties,
  wikiPagePropertiesToolSchema,
  type WikiPageProperties,
  type WikiSourceRef,
} from "../wiki/properties";
import { isOwnedAtWrite } from "./wikiOwnership";
import { assertProjectRole } from "./projectAccess";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { withProjectRepo } from "./projectRepo";

/** What the run row vouches for; WikiRun supplies it once it exists. */
export type WikiWriteFence = {
  agentId: string;
  projectId: string;
  runId: string;
  assertLive(): Promise<void>;
};

/** Settings-owned protected locations, supplied by the fence provider. */
export type WikiWriteGuards = {
  guideDocumentId: string | null;
  sourceFolderPaths: string[];
  /** A recorded source folder id does not resolve; creates are refused until it does. */
  sourceFoldersUnresolved: boolean;
};

const sourceRefSchema = z.strictObject({
  kind: z.enum(["document", "table"]),
  id: z.uuid(),
});

// Strict: no title on a patch and no author metadata, structurally.
// `properties` is the tool subset: no sources and no reviewExempt; `source` is set by the session.
export const wikiOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("document.create"),
    projectId: z.uuid(),
    folderPath,
    title,
    markdown: z.string().max(MAX_MARKDOWN_CHARS),
    properties: wikiPagePropertiesToolSchema.optional(),
    source: sourceRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("document.patch"),
    projectId: z.uuid(),
    documentId: z.uuid(),
    baseCommitSha: sha,
    actions: z.array(patchActionSchema).max(50),
    properties: wikiPagePropertiesToolSchema.optional(),
    source: sourceRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("content.lifecycle"),
    action: z.literal("folder_create"),
    projectId: z.uuid(),
    parentPath: folderPath,
    name: z.string().trim().min(1).max(80),
  }),
]);
export type WikiOperation = z.infer<typeof wikiOperationSchema>;

export type WikiWriteResult = {
  projectId: string;
  resourceId: string | null;
  path: string;
  commitSha: string;
  recovered: boolean;
};

/** What a write will change; persisted immediately before the commit. */
export type WikiWriteMeasure = BudgetDelta & {
  documentId: string | null;
  path: string | null;
  baseCommitSha: string | null;
  /** Non-owned page writes count against the run's page and run budgets. */
  owned: boolean;
  /** One per commit, plus one per property changed on a non-owned page. */
  writes: number;
};

/** The run's ledger as the write path sees it; read and written under the project lock. */
export type WikiWriteLedger = {
  counters(
    documentId: string,
  ): Promise<{ page: BudgetDelta; run: BudgetDelta }>;
  record(measure: WikiWriteMeasure): Promise<void>;
  refused(decision: Extract<BudgetDecision, { allowed: false }>): Promise<void>;
};

const NO_LEDGER: WikiWriteLedger = {
  counters: async () => ({
    page: { grossCharsChanged: 0, charsAdded: 0 },
    run: { grossCharsChanged: 0, charsAdded: 0 },
  }),
  record: async () => undefined,
  refused: async () => undefined,
};

export function appendSource(
  sources: readonly WikiSourceRef[] | undefined,
  source: WikiSourceRef,
): WikiSourceRef[] {
  const kept = (sources ?? []).filter(
    (entry) => !(entry.kind === source.kind && entry.id === source.id),
  );
  return [...kept, source].slice(-MAX_WIKI_SOURCES);
}

function budgetRefusal(
  decision: Extract<BudgetDecision, { allowed: false }>,
): CoreError {
  return new CoreError("CONFLICT", decision.message, {
    reason: "BUDGET_REFUSED",
    budget: decision.code,
  });
}

/** A fragment can only form a link once combined with its surroundings, so the result is what is checked. */
async function assertNewLinkTargetsExist(
  db: PrismaClient,
  projectId: string,
  before: string | null,
  after: string,
): Promise<void> {
  const known = new Set(before === null ? [] : weaverLinkTargets(before));
  for (const target of new Set(weaverLinkTargets(after))) {
    if (known.has(target)) continue;
    const tracked = parseTrackedTarget(target);
    const exists = !tracked
      ? false
      : tracked.kind === "document"
        ? await db.document.count({ where: { id: tracked.id, projectId } })
        : await db.dataTable.count({ where: { id: tracked.id, projectId } });
    if (!exists)
      throw new CoreError(
        "BAD_REQUEST",
        "This write would create a link to something that does not exist in this project",
        { reason: "UNVERIFIABLE_LINKS" },
      );
  }
}

function changedPropertyCount(
  properties: Extract<WikiOperation, { kind: "document.patch" }>["properties"],
): number {
  return properties ? Object.keys(properties).length : 0;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The agent mints only run ids; source and revert writers have their own entry points.
const OPERATION_ID_RE = new RegExp(`^wiki-run:(${UUID}):\\d{4}$`);
const IMAGE_REFERENCE_RE = /weaver-image:/gi;
const IMG_TAG_RE = /<\s*img\b/gi;

function refused(message: string): CoreError {
  return new CoreError("FORBIDDEN", message);
}

/** Refuses a kind or action outside the union before any input validation. */
function assertWikiOperationKind(raw: unknown): void {
  const shape = (raw ?? {}) as { kind?: unknown; action?: unknown };
  const allowed =
    shape.kind === "document.create" ||
    shape.kind === "document.patch" ||
    (shape.kind === "content.lifecycle" && shape.action === "folder_create");
  if (!allowed)
    throw refused("This operation is not available to the wiki agent");
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function assertNoImageMarkup(text: string): void {
  if (countMatches(text, IMAGE_REFERENCE_RE) > 0)
    throw refused("The wiki agent cannot add weaver-image references");
  if (countMatches(text, IMG_TAG_RE) > 0)
    throw refused("The wiki agent cannot add <img> tags");
}

/** Catches markup assembled across action boundaries; existing images may stay. */
function assertPatchAddsNoImageMarkup(before: string, after: string): void {
  if (
    countMatches(after, IMAGE_REFERENCE_RE) >
      countMatches(before, IMAGE_REFERENCE_RE) ||
    countMatches(after, IMG_TAG_RE) > countMatches(before, IMG_TAG_RE)
  )
    throw refused("The wiki agent cannot add image references or <img> tags");
}

function normalizedSegments(path: readonly string[]): string[] {
  return path.map((segment) => segment.normalize("NFC").toLowerCase());
}

function isWithin(
  segments: readonly string[],
  ancestor: readonly string[],
): boolean {
  return (
    ancestor.length > 0 &&
    ancestor.length <= segments.length &&
    ancestor.every((part, index) => segments[index] === part)
  );
}

function assertOutsideSourceFolders(
  segments: readonly string[],
  guards: WikiWriteGuards,
): void {
  const target = normalizedSegments(segments);
  for (const source of guards.sourceFolderPaths) {
    const folder = normalizedSegments(source.split("/").filter(Boolean));
    if (isWithin(target, folder))
      throw refused("Source folders are not editable by the wiki agent");
  }
}

async function assertPatchablePage(
  db: PrismaClient,
  operation: Extract<WikiOperation, { kind: "document.patch" }>,
  guards: WikiWriteGuards,
): Promise<string | null> {
  const row = await db.document.findFirst({
    where: { id: operation.documentId, projectId: operation.projectId },
    select: { id: true, path: true, kind: true, wikiSourceItemId: true },
  });
  if (!row) return null;
  if (row.kind === "python")
    throw refused("Python documents are not editable by the wiki agent");
  if (row.id === guards.guideDocumentId)
    throw refused("The wiki guide is not editable by the wiki agent");
  if (row.wikiSourceItemId !== null)
    throw refused("Source pages are not editable by the wiki agent");
  assertOutsideSourceFolders(row.path.split("/").slice(0, -1), guards);
  const taskOutputs =
    (await db.scheduledTask.count({
      where: { outputProjectId: operation.projectId, outputDocumentId: row.id },
    })) +
    (await db.scheduledTaskRun.count({ where: { outputDocumentId: row.id } }));
  if (taskOutputs > 0)
    throw refused("Scheduled task output is not editable by the wiki agent");
  return row.path;
}

function assertOperationImages(operation: WikiOperation): void {
  if (operation.kind === "document.create")
    assertNoImageMarkup(operation.markdown);
  if (operation.kind === "document.patch")
    for (const action of operation.actions) {
      if ("text" in action) assertNoImageMarkup(action.text);
      if ("replace" in action) assertNoImageMarkup(action.replace);
    }
}

function assertOperationLocation(
  operation: WikiOperation,
  guards: WikiWriteGuards,
): void {
  if (guards.sourceFoldersUnresolved && operation.kind !== "document.patch")
    throw new CoreError(
      "CONFLICT",
      "The wiki sources folder cannot be resolved; creating content is paused",
      { reason: "SOURCE_FOLDER_UNRESOLVED" },
    );
  if (operation.kind === "document.create")
    assertOutsideSourceFolders(operation.folderPath, guards);
  if (operation.kind === "content.lifecycle")
    assertOutsideSourceFolders(
      [...operation.parentPath, slugify(operation.name)],
      guards,
    );
}

/** Agent pages get the exemption through this internal path; the operation cannot name it. */
function agentPageProperties(
  operation: Extract<WikiOperation, { kind: "document.create" }>,
): WikiPageProperties {
  const { type, summary, tags } = operation.properties ?? {};
  return (
    normalizeProperties({
      type: type ?? undefined,
      summary: summary ?? undefined,
      tags: tags ?? undefined,
      reviewExempt: true,
      ...(operation.source ? { sources: [operation.source] } : {}),
    }) ?? { reviewExempt: true }
  );
}

/** Under the project lock, on the worktree body: ownership, shape, then counters. */
async function admitPatch(
  db: PrismaClient,
  repo: Parameters<typeof applyDocumentPatchOperation>[1],
  operation: Extract<WikiOperation, { kind: "document.patch" }>,
  agentId: string,
  ledger: WikiWriteLedger,
): Promise<{
  measure: WikiWriteMeasure;
  propertiesInput: Extract<
    ContentOperation,
    { kind: "document.patch" }
  >["properties"];
}> {
  // A source reference alone must not let an untouched page count as integration.
  if (operation.actions.length === 0 && !operation.properties)
    throw new CoreError("BAD_REQUEST", "A patch needs actions or properties");
  const row = await db.document.findFirstOrThrow({
    where: { id: operation.documentId, projectId: operation.projectId },
    select: { path: true },
  });
  const owned = await isOwnedAtWrite(db, repo, {
    documentId: operation.documentId,
    path: row.path,
    agentId,
  });
  const refuseWith = async (
    decision: Extract<BudgetDecision, { allowed: false }>,
  ): Promise<never> => {
    await ledger.refused(decision);
    throw budgetRefusal(decision);
  };
  if (!owned) {
    const shape = checkNonOwnedActions(operation.actions);
    if (!shape.allowed) await refuseWith(shape);
  }
  const kind = documentKindOfPath(row.path);
  const file = parseDocumentFile(
    await repo.readFileFromWorktree(row.path),
    kind,
  );
  const canonical = serializeDocumentBody(parseDocumentBody(file.body));
  const delta = measurePatch(
    compileDocumentPatch(canonical, operation.actions, kind),
  );
  const counters = await ledger.counters(operation.documentId);
  const budget = checkBudget({ owned, ...counters, delta });
  if (!budget.allowed) await refuseWith(budget);
  await assertNewLinkTargetsExist(
    db,
    operation.projectId,
    canonical,
    applyDocumentPatch(canonical, operation.actions, kind),
  );
  const sources = operation.source
    ? appendSource(file.meta.properties?.sources, operation.source)
    : undefined;
  const propertiesInput =
    operation.properties || sources
      ? {
          ...operation.properties,
          ...(sources ? { sources } : {}),
        }
      : undefined;
  const baseCommitSha = operation.baseCommitSha;
  return {
    propertiesInput,
    measure: {
      ...delta,
      documentId: operation.documentId,
      path: row.path,
      baseCommitSha,
      owned,
      writes: owned
        ? 1
        : Math.max(
            1,
            (operation.actions.length > 0 ? 1 : 0) +
              changedPropertyCount(operation.properties),
          ),
    },
  };
}

/** The canonical request identity recorded as Weaver-Wiki-Request-Hash. */
export function wikiRequestHash(operation: WikiOperation): string {
  const parsed = wikiOperationSchema.safeParse(operation);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CoreError(
      "BAD_REQUEST",
      `Invalid wiki operation${issue ? `: ${issue.path.join(".")} ${issue.message}` : ""}`,
    );
  }
  return createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
}

/**
 * The wiki agent's only write path: one commit per operation under the project
 * lock, fenced by the run, with recovery that trusts only ledger-trusted
 * commits carrying this agent's trailer and this request hash.
 */
export async function applyWikiOperation(
  db: PrismaClient,
  input: {
    run: WikiWriteFence;
    /** Resolved under the project lock so a settings change cannot go unseen. */
    guards: () => Promise<WikiWriteGuards>;
    operation: WikiOperation;
    operationId: string;
    summary?: string;
    beforeCommit?: () => Promise<void>;
    ledger?: WikiWriteLedger;
  },
): Promise<WikiWriteResult> {
  const ledger = input.ledger ?? NO_LEDGER;
  const { run } = input;
  assertWikiOperationKind(input.operation);
  const parsed = wikiOperationSchema.safeParse(input.operation);
  if (!parsed.success)
    throw new CoreError("BAD_REQUEST", "Invalid wiki operation");
  const operation = parsed.data;
  const idMatch = OPERATION_ID_RE.exec(input.operationId);
  if (!idMatch || (idMatch[1] !== undefined && idMatch[1] !== run.runId))
    throw new CoreError("BAD_REQUEST", "Invalid wiki operation id");
  const requestHash = wikiRequestHash(operation);
  const summary = (input.summary ?? "Wiki agent update").trim();
  if (
    summary.length === 0 ||
    summary.length > 500 ||
    /[\x00-\x1f\x7f]/.test(summary)
  )
    throw new CoreError("BAD_REQUEST", "Invalid wiki change summary");

  const actor = createWikiAgentSecurityContext({
    agentId: run.agentId,
    projectId: run.projectId,
  });
  await assertProjectRole(db, operation.projectId, actor, "Editor");
  assertOperationImages(operation);
  await run.assertLive();

  const author = wikiAgentContentAuthor(actor);
  const identity: RecoveryIdentity = {
    wikiAgentId: run.agentId,
    wikiRequestHash: requestHash,
  };
  let measure: WikiWriteMeasure | null = null;
  const options = {
    table: null,
    summary,
    operationId: input.operationId,
    runId: run.runId,
    wikiRequestHash: requestHash,
    message: (path: string) => `wiki: ${path}`,
    assertPatched: assertPatchAddsNoImageMarkup,
    beforeCommit: async () => {
      await run.assertLive();
      await assertProjectRole(db, operation.projectId, actor, "Editor");
      await input.beforeCommit?.();
      // Before the commit, so a crash over-counts rather than forgetting a written change.
      if (measure) await ledger.record(measure);
    },
  };

  const outcome = await withProjectRepo(operation.projectId, async (repo) => {
    await run.assertLive();
    const guards = await input.guards();
    assertOperationLocation(operation, guards);
    if (operation.kind === "document.patch") {
      const path = await assertPatchablePage(db, operation, guards);
      if (path === null)
        throw new CoreError("NOT_FOUND", "target no longer exists");
      // A retry whose base already moved past its own commit must not apply twice.
      const prior = await findCommitByOperationId(
        repo,
        path,
        input.operationId,
      );
      if (prior) {
        const verified = await findCommitByOperationId(
          repo,
          path,
          input.operationId,
          identity,
        );
        if (!verified)
          throw new CoreError(
            "CONFLICT",
            "A commit under this operation id cannot be verified",
            { reason: "IDEMPOTENCY_KEY_REUSED" },
          );
        return {
          applied: {
            commitSha: verified,
            resourceId: operation.documentId,
            path,
          },
          committed: false,
        };
      }
    }
    // A folder create's guard is the HEAD read under this lock, not the agent's input.
    const content: ContentOperation =
      operation.kind === "content.lifecycle"
        ? {
            ...operation,
            resourceType: "document",
            baseProjectCommitSha: await repo.resolveHead(),
          }
        : operation;
    return recoverCheckApply({
      db,
      repo,
      operation: content,
      operationId: input.operationId,
      identity,
      apply: async (): Promise<AppliedOperation> => {
        switch (content.kind) {
          case "document.create": {
            await assertNewLinkTargetsExist(
              db,
              operation.projectId,
              null,
              content.markdown,
            );
            const created = operation as Extract<
              WikiOperation,
              { kind: "document.create" }
            >;
            measure = {
              ...measureCreate(content.markdown),
              documentId: null,
              path: null,
              baseCommitSha: null,
              owned: true,
              writes: 1,
            };
            return applyDocumentCreate(
              db,
              repo,
              { ...content, properties: undefined },
              author,
              {
                ...options,
                systemProperties: agentPageProperties(created),
              },
            );
          }
          case "document.patch": {
            const patch = operation as Extract<
              WikiOperation,
              { kind: "document.patch" }
            >;
            const admitted = await admitPatch(
              db,
              repo,
              patch,
              run.agentId,
              ledger,
            );
            measure = admitted.measure;
            return applyDocumentPatchOperation(
              db,
              repo,
              { ...content, properties: admitted.propertiesInput },
              author,
              options,
            );
          }
          case "content.lifecycle":
            return applyFolderCreate(repo, content, author, {
              operationId: options.operationId,
              runId: options.runId,
              wikiRequestHash: options.wikiRequestHash,
              beforeCommit: options.beforeCommit,
            });
          default:
            throw refused("This operation is not available to the wiki agent");
        }
      },
    });
  });
  // The dispatch takes the shared read lock, so it runs after the write lock is released.
  if (outcome.committed)
    void notifyProjectContentChanged(db, operation.projectId);
  return {
    projectId: operation.projectId,
    resourceId: outcome.applied.resourceId,
    path: outcome.applied.path,
    commitSha: outcome.applied.commitSha,
    recovered: !outcome.committed,
  };
}
