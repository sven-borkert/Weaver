import { createHash } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type WikiInputItem,
} from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { redactSecrets } from "../security/redactSecrets";
import {
  scanForSecrets,
  scanTableForSecrets,
  type SecretHit,
} from "../security/secretScan";
import { parseStoredTable, retireWikiIngestionFile } from "./ingestion";
import { buildAcceptOperation } from "./ingestionAccept";
import { neutralInputTitle } from "./wikiInputs";
import { isClosedFence } from "./wikiRuns";
import {
  isLiveSource,
  sourceTitle,
  writeFileSource,
  writeTextSource,
  type SourceBody,
  type SourceResult,
  type SourceRun,
} from "./wikiSourceWriter";

export function contentDigest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function markItemReady(
  db: PrismaClient,
  run: SourceRun,
  itemId: string,
  data: { sourceDocumentId?: string; sourceTableId?: string } = {},
): Promise<void> {
  // The link is kept even after a fence closes; only the status change is conditional.
  if (data.sourceDocumentId || data.sourceTableId)
    await db.wikiInputItem.updateMany({ where: { id: itemId }, data });
  await db.wikiInputItem.updateMany({
    where: { id: itemId, runId: run.id, status: "preparing" },
    data: {
      status: "ready",
      errorCode: null,
      errorMessage: null,
      revision: { increment: 1 },
    },
  });
}

export async function failItem(
  db: PrismaClient,
  run: SourceRun,
  itemId: string,
  code: string,
  message: string,
): Promise<void> {
  const { count } = await db.wikiInputItem.updateMany({
    where: { id: itemId, runId: run.id, status: "preparing" },
    data: {
      status: "failed",
      errorCode: code.slice(0, 64),
      errorMessage: redactSecrets(message).slice(0, 500),
      revision: { increment: 1 },
    },
  });
  if (count === 1)
    emitDiagnostic({
      event: "wiki.input.failed",
      severity: "warn",
      message: "wiki input failed",
      outcome: "error",
      projectId: run.projectId,
      details: { itemId, code },
    });
}

export async function holdItem(
  db: PrismaClient,
  run: SourceRun,
  itemId: string,
  hits: SecretHit[],
  digest: string,
  /** Replaces a title drawn from flagged content; a held item must not show it. */
  title?: string,
): Promise<void> {
  const { count } = await db.wikiInputItem.updateMany({
    where: { id: itemId, runId: run.id, status: "preparing" },
    data: {
      status: "held",
      ...(title === undefined ? {} : { title }),
      heldHits: hits,
      heldDigest: digest,
      revision: { increment: 1 },
    },
  });
  if (count === 1)
    emitDiagnostic({
      event: "wiki.input.held",
      severity: "warn",
      message: "wiki input held by the secret scanner",
      outcome: "blocked",
      projectId: run.projectId,
      details: {
        itemId,
        kinds: [...new Set(hits.map((hit) => hit.kind))],
        hits: hits.length,
      },
    });
}

/** A recorded source whose page is gone cannot be re-created under the same operation id. */
export const SOURCE_DELETED_MESSAGE =
  "The source page of this input was deleted. Remove this input and add it again.";

async function prepareText(
  db: PrismaClient,
  run: SourceRun,
  item: WikiInputItem,
): Promise<void> {
  if (item.text === null) {
    await failItem(db, run, item.id, "TEXT_MISSING", "The note text is gone.");
    return;
  }
  // The title is outside the digest: it can only become more neutral, never less.
  const digest = contentDigest([item.text]);
  const neutral = neutralInputTitle("text", item.createdAt);
  const title =
    scanForSecrets(item.title, "title").length > 0 ? neutral : item.title;
  if (title !== item.title)
    await db.wikiInputItem.updateMany({
      where: { id: item.id },
      data: { title },
    });
  if (item.confirmedDigest !== digest) {
    const hits = scanForSecrets(item.text, "note");
    if (hits.length > 0) {
      await holdItem(db, run, item.id, hits, digest, neutral);
      return;
    }
  }
  const written = await writeTextSource(db, run, {
    id: item.id,
    title,
    text: item.text,
    textDigest: digest,
  });
  if (written.recovered) {
    const live = await db.document.findFirst({
      where: { id: written.resourceId, projectId: run.projectId },
      select: { id: true },
    });
    if (!live) {
      await failItem(
        db,
        run,
        item.id,
        "SOURCE_DELETED",
        SOURCE_DELETED_MESSAGE,
      );
      return;
    }
  }
  await markItemReady(db, run, item.id, {
    sourceDocumentId: written.resourceId,
  });
}

function draftBody(
  projectId: string,
  title: string,
  draft: NonNullable<LoadedFile>["draft"],
): SourceBody {
  if (!draft) throw new CoreError("CONFLICT", "The parsed draft is gone");
  const table =
    draft.targetKind === "table"
      ? parseStoredTable(draft.tableSchema, draft.tableRows)
      : null;
  const operation = buildAcceptOperation(projectId, {
    targetKind: draft.targetKind,
    proposedTitle: title,
    proposedFolderPath: "",
    markdown: draft.markdown,
    columns: table?.columns ?? null,
    rows: table?.rows ?? null,
    links: [],
  });
  if (operation.kind === "document.create")
    return { kind: "document", markdown: operation.markdown };
  if (operation.kind === "table.create")
    return { kind: "table", columns: operation.columns, rows: operation.rows };
  throw new CoreError("INTERNAL_SERVER_ERROR", "Unexpected source operation");
}

type LoadedFile = Awaited<ReturnType<typeof loadWikiFile>>;

function loadWikiFile(db: PrismaClient, projectId: string, fileId: string) {
  return db.ingestionFile.findFirst({
    where: { id: fileId, projectId, batch: { origin: "wiki" } },
    include: { draft: true },
  });
}

async function failFileItem(
  db: PrismaClient,
  run: SourceRun,
  item: WikiInputItem,
  code: string,
  message: string,
): Promise<void> {
  await failItem(db, run, item.id, code, message);
  if (item.ingestionFileId) {
    const fileId = item.ingestionFileId;
    await db.$transaction((tx) => retireWikiIngestionFile(tx, fileId));
  }
}

/** The tick, not the parse worker, turns a ready wiki file into a source. */
async function prepareFile(
  db: PrismaClient,
  run: SourceRun,
  item: WikiInputItem,
): Promise<void> {
  if (!item.ingestionFileId) {
    await failItem(
      db,
      run,
      item.id,
      "PARSE_FILE_MISSING",
      "The parsed file is gone. Retry this input.",
    );
    return;
  }
  const file = await loadWikiFile(db, run.projectId, item.ingestionFileId);
  if (!file) {
    await failItem(
      db,
      run,
      item.id,
      "PARSE_FILE_MISSING",
      "The parsed file is gone. Retry this input.",
    );
    return;
  }
  switch (file.status) {
    case "ready":
    case "accepting":
      break;
    case "accepted": {
      const resourceId = file.draft?.acceptedResourceId;
      const kind = file.draft?.targetKind;
      const live =
        resourceId &&
        (kind === "table"
          ? await db.dataTable.count({
              where: { id: resourceId, projectId: run.projectId },
            })
          : await db.document.count({
              where: { id: resourceId, projectId: run.projectId },
            }));
      if (!live) {
        await failItem(
          db,
          run,
          item.id,
          "SOURCE_DELETED",
          SOURCE_DELETED_MESSAGE,
        );
        return;
      }
      await markItemReady(
        db,
        run,
        item.id,
        kind === "table"
          ? { sourceTableId: resourceId }
          : { sourceDocumentId: resourceId },
      );
      return;
    }
    case "failed":
    case "blocked_configuration":
      await failItem(
        db,
        run,
        item.id,
        "PARSE_FAILED",
        file.failureMessage ?? "The file could not be read.",
      );
      return;
    case "rejected":
      await failItem(
        db,
        run,
        item.id,
        "PARSE_FILE_MISSING",
        "The parsed file is gone. Retry this input.",
      );
      return;
    default:
      return; // Still parsing; the next tick looks again.
  }
  const draft = file.draft;
  if (!draft) {
    await failFileItem(
      db,
      run,
      item,
      "PARSE_FILE_MISSING",
      "The parsed draft is gone. Retry this input.",
    );
    return;
  }
  if (file.contentDigest !== item.artifactDigest) {
    await failFileItem(
      db,
      run,
      item,
      "ARTIFACT_CHANGED",
      "The original file changed. Remove this input and add the file again.",
    );
    return;
  }
  const table =
    draft.targetKind === "table"
      ? parseStoredTable(draft.tableSchema, draft.tableRows)
      : null;
  const digest = contentDigest([
    file.fileName,
    draft.targetKind,
    draft.markdown,
    table,
  ]);
  if (item.confirmedDigest !== digest) {
    const hits = [
      ...scanForSecrets(file.fileName, "file"),
      ...(table
        ? scanTableForSecrets(
            table.columns.map((column) => column.name),
            table.rows,
          )
        : scanForSecrets(draft.markdown ?? "", "draft")),
    ];
    if (hits.length > 0) {
      // The file stays ready, its draft parked, until an Editor confirms or removes it.
      await holdItem(
        db,
        run,
        item.id,
        hits,
        digest,
        scanForSecrets(item.title, "file").length > 0
          ? neutralInputTitle("file", item.createdAt)
          : undefined,
      );
      return;
    }
  }
  await db.ingestionFile.updateMany({
    where: { id: file.id, status: "ready" },
    data: { status: "accepting" },
  });
  let written: SourceResult;
  try {
    written = await writeFileSource(
      db,
      run,
      { id: item.id, title: item.title },
      {
        id: file.id,
        contentDigest: file.contentDigest,
        draftDigest: digest,
      },
      draftBody(run.projectId, sourceTitle(item.title), draft),
    );
  } catch (error) {
    // Nothing committed: a parked file may be accepted again; a real failure retires it below.
    await db.ingestionFile.updateMany({
      where: { id: file.id, status: "accepting" },
      data: { status: "ready" },
    });
    if (isClosedFence(error) || !(error instanceof CoreError)) throw error;
    await failFileItem(
      db,
      run,
      item,
      String(error.details?.reason ?? error.code),
      error.message,
    );
    return;
  }
  const warnings = draft.warnings.join(" ").slice(0, 2_000);
  await db.$transaction(async (tx) => {
    const finalized = await tx.ingestionFile.updateMany({
      where: { id: file.id, status: "accepting" },
      data: { status: "accepted", failureKind: null, failureMessage: null },
    });
    if (finalized.count === 1)
      await tx.ingestionDraft.update({
        where: { fileId: file.id },
        data: {
          acceptedResourceId: written.resourceId,
          acceptedCommitSha: written.commitSha,
          markdown: null,
          tableRows: Prisma.DbNull,
          tableSchema: Prisma.DbNull,
        },
      });
    if (warnings)
      await tx.wikiInputItem.updateMany({
        where: { id: item.id },
        data: { outcomeNote: redactSecrets(warnings) },
      });
  });
  if (written.recovered) {
    const live =
      written.kind === "table"
        ? await db.dataTable.count({
            where: { id: written.resourceId, projectId: run.projectId },
          })
        : await db.document.count({
            where: { id: written.resourceId, projectId: run.projectId },
          });
    if (!live) {
      await failItem(
        db,
        run,
        item.id,
        "SOURCE_DELETED",
        SOURCE_DELETED_MESSAGE,
      );
      return;
    }
  }
  await markItemReady(
    db,
    run,
    item.id,
    written.kind === "table"
      ? { sourceTableId: written.resourceId }
      : { sourceDocumentId: written.resourceId },
  );
}

/** One tick's work on a preparing run. A refused or broken item never blocks its neighbours. */
export async function prepareRunItems(
  db: PrismaClient,
  run: SourceRun,
): Promise<void> {
  const items = await db.wikiInputItem.findMany({
    where: { runId: run.id, status: "preparing" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      if (await isLiveSource(db, item)) {
        await markItemReady(db, run, item.id);
      } else if (item.kind === "text") {
        await prepareText(db, run, item);
      } else {
        await prepareFile(db, run, item);
      }
    } catch (error) {
      if (isClosedFence(error)) continue;
      if (error instanceof CoreError) {
        await failItem(
          db,
          run,
          item.id,
          String(error.details?.reason ?? error.code),
          error.message,
        );
        continue;
      }
      // Infrastructure errors retry on the next tick, bounded by the 75-minute limit.
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "wiki preparation failed for some items");
}
