import { createHash } from "node:crypto";
import type { PrismaClient, WikiInputItem } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { redactSecrets } from "../security/redactSecrets";
import { scanForSecrets, type SecretHit } from "../security/secretScan";
import { neutralInputTitle } from "./wikiInputs";
import { isClosedFence } from "./wikiRuns";
import {
  isLiveSource,
  writeTextSource,
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

export type PrepareFile = (
  db: PrismaClient,
  run: SourceRun,
  item: WikiInputItem,
) => Promise<void>;

/** One tick's work on a preparing run. A refused or broken item never blocks its neighbours. */
export async function prepareRunItems(
  db: PrismaClient,
  run: SourceRun,
  options: { prepareFile?: PrepareFile } = {},
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
        await options.prepareFile?.(db, run, item);
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
