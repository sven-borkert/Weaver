import { createHash } from "node:crypto";
import path from "node:path";
import { parseServerEnv } from "@weaver/config/server";
import type { PrismaClient, ArtifactNotebook } from "@weaver/db/client";
import { CoreError } from "../errors";
import {
  isNotebookFilename,
  NOTEBOOK_PARSER_VERSION,
  NOTEBOOK_RETRY_COOLDOWN_MS,
  NOTEBOOK_ASSET_MAX_BYTES,
  NOTEBOOK_PAGE_MAX_BYTES,
  notebookPageSchema,
  notebookDigestSchema,
  notebookIdSchema,
  type NotebookStatus,
} from "../artifacts/notebookSchema";
import {
  notebookClaimDir,
  readNotebookManifest,
  readNotebookFile,
  validImageSignature,
} from "../artifacts/notebookStorage";
import {
  CLEARED_NOTEBOOK_SUMMARY,
  queueNotebookPreparation,
  requestNotebookPreparation,
} from "./artifactNotebookJobs";
import { getArtifact, type ArtifactSummary } from "./artifacts";
import { withProjectIngestionLifecycleLock } from "./ingestion";
import type { ProjectActor } from "./projectAccess";

type Input = { projectId: string; artifactId: string };
type RevisionInput = Input & { contentDigest: string };
type Options = { dataDir?: string };
export type ArtifactNotebookOverview = {
  artifact: ArtifactSummary;
  status: NotebookStatus;
  contentDigest: string;
  error: string | null;
  sections: {
    id: string;
    title: string;
    path: string[];
    pageCount: number;
    warnings: string[];
  }[];
  warnings: string[];
  /** While `failed`: the earliest time `retry` is accepted, or null once the
   *  cooldown has passed. Null in every other status. */
  retryAllowedAt: string | null;
  /** True on the response to a `retry` that was refused by the cooldown. */
  retryRefused: boolean;
};
const changed = () =>
  new CoreError("CONFLICT", "Notebook source changed; reload the notebook");
const unready = () =>
  new CoreError(
    "PRECONDITION_FAILED",
    "Notebook is not ready; prepare or retry it",
  );
const snapshotUnavailable = () =>
  new CoreError("PRECONDITION_FAILED", "Notebook cache is unavailable", {
    reason: "SNAPSHOT_UNAVAILABLE",
  });
const dataDirectory = (options: Options) =>
  options.dataDir ?? parseServerEnv(process.env).WEAVER_DATA_DIR;

async function authorizedNotebook(
  db: PrismaClient,
  actor: ProjectActor,
  input: Input,
) {
  const artifact = await getArtifact(db, actor, input);
  if (!isNotebookFilename(artifact.filename))
    throw new CoreError("BAD_REQUEST", "This file is not a OneNote notebook");
  return artifact;
}
function isCurrent(
  state: ArtifactNotebook | null,
  artifact: ArtifactSummary,
): state is ArtifactNotebook {
  return (
    state !== null &&
    state.contentDigest === artifact.contentDigest &&
    state.parserVersion === NOTEBOOK_PARSER_VERSION
  );
}
async function checkRevision(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput,
) {
  const artifact = await authorizedNotebook(db, actor, input);
  if (artifact.contentDigest !== input.contentDigest) throw changed();
  return artifact;
}
async function invalidateSnapshot(db: PrismaClient, state: ArtifactNotebook) {
  await db.artifactNotebook.updateMany({
    where: {
      artifactId: state.artifactId,
      status: "ready",
      claimToken: state.claimToken,
      contentDigest: state.contentDigest,
    },
    data: {
      status: "failed",
      error: "snapshot_unavailable",
      claimToken: null,
      snapshotBytes: 0,
      finishedAt: new Date(),
      ...CLEARED_NOTEBOOK_SUMMARY,
    },
  });
}
/** When a failed row may be retried; null once the cooldown has passed. A
 *  lost or damaged cache is not a preparation failure and may be rebuilt at
 *  once, so the cooldown only covers parse failures, timeouts and memory. */
function retryAllowedAt(
  state: Pick<ArtifactNotebook, "updatedAt" | "error">,
  now = new Date(),
): string | null {
  if (state.error === "snapshot_unavailable") return null;
  const allowedAt = new Date(
    state.updatedAt.getTime() + NOTEBOOK_RETRY_COOLDOWN_MS,
  );
  return allowedAt > now ? allowedAt.toISOString() : null;
}
/** A current row needs no new preparation unless it failed and a retry is asked. */
function settled(
  state: ArtifactNotebook | null,
  artifact: ArtifactSummary,
  retry: boolean | undefined,
): boolean {
  return isCurrent(state, artifact) && !(state.status === "failed" && retry);
}
function retryRefused(
  state: ArtifactNotebook | null,
  artifact: ArtifactSummary,
  retry: boolean | undefined,
): boolean {
  return (
    retry === true &&
    isCurrent(state, artifact) &&
    state.status === "failed" &&
    retryAllowedAt(state) !== null
  );
}
async function readySnapshot(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput,
  options: Options,
) {
  const artifact = await checkRevision(db, actor, input);
  const state = await db.artifactNotebook.findUnique({
    where: { artifactId: artifact.id },
  });
  if (
    isCurrent(state, artifact) &&
    state.status === "failed" &&
    state.error === "snapshot_unavailable"
  )
    throw snapshotUnavailable();
  if (
    !isCurrent(state, artifact) ||
    state.status !== "ready" ||
    !state.claimToken
  )
    throw unready();
  const dataDir = dataDirectory(options);
  const dir = notebookClaimDir(
    dataDir,
    artifact.projectId,
    artifact.id,
    state.contentDigest,
    state.parserVersion,
    state.claimToken,
  );
  try {
    return {
      state,
      dataDir,
      dir,
      manifest: await readNotebookManifest(dataDir, dir),
    };
  } catch {
    await invalidateSnapshot(db, state);
    throw snapshotUnavailable();
  }
}
async function recheckSnapshot(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput,
  claimToken: string | null,
) {
  await checkRevision(db, actor, input);
  const state = await db.artifactNotebook.findUnique({
    where: { artifactId: input.artifactId },
  });
  if (
    state?.status !== "ready" ||
    state.claimToken !== claimToken ||
    state.contentDigest !== input.contentDigest
  )
    throw changed();
}

export async function getArtifactNotebook(
  db: PrismaClient,
  actor: ProjectActor,
  input: Input,
  options: Options = {},
): Promise<ArtifactNotebookOverview> {
  const artifact = await authorizedNotebook(db, actor, input);
  const state = await db.artifactNotebook.findUnique({
    where: { artifactId: artifact.id },
  });
  const overview: ArtifactNotebookOverview = {
    artifact,
    status: isCurrent(state, artifact) ? state.status : "unprepared",
    contentDigest: artifact.contentDigest,
    error: isCurrent(state, artifact) ? state.error : null,
    sections: [],
    warnings: [],
    retryAllowedAt:
      isCurrent(state, artifact) && state.status === "failed"
        ? retryAllowedAt(state)
        : null,
    retryRefused: false,
  };
  if (overview.status !== "ready") return overview;
  const revision = { ...input, contentDigest: artifact.contentDigest };
  try {
    const snapshot = await readySnapshot(db, actor, revision, options);
    overview.sections = snapshot.manifest.sections.map((section) => ({
      id: section.id,
      title: section.title,
      path: section.path,
      pageCount: section.pages.length,
      warnings: section.warnings,
    }));
    overview.warnings = snapshot.manifest.warnings;
    await recheckSnapshot(db, actor, revision, snapshot.state.claimToken);
    return overview;
  } catch (error) {
    if (error instanceof CoreError && error.code === "PRECONDITION_FAILED")
      return {
        ...overview,
        status: "failed",
        error: "snapshot_unavailable",
        retryAllowedAt: null,
      };
    throw error;
  }
}

export async function prepareArtifactNotebook(
  db: PrismaClient,
  actor: ProjectActor,
  input: Input & { retry?: boolean },
  options: Options = {},
): Promise<ArtifactNotebookOverview> {
  const artifact = await authorizedNotebook(db, actor, input);
  // Lock-free first look: a current cache is the common case and must not
  // queue behind uploads, renames and deletes that hold the lifecycle lock.
  const seen = await db.artifactNotebook.findUnique({
    where: { artifactId: artifact.id },
  });
  if (settled(seen, artifact, input.retry))
    return getArtifactNotebook(db, actor, input, options);
  if (retryRefused(seen, artifact, input.retry))
    return {
      ...(await getArtifactNotebook(db, actor, input, options)),
      retryRefused: true,
    };
  const payload = await withProjectIngestionLifecycleLock(
    db,
    input.projectId,
    async (tx) => {
      const artifact = await getArtifact(tx, actor, input);
      if (!isNotebookFilename(artifact.filename))
        throw new CoreError(
          "BAD_REQUEST",
          "This file is not a OneNote notebook",
        );
      const current = await tx.artifactNotebook.findUnique({
        where: { artifactId: artifact.id },
      });
      if (settled(current, artifact, input.retry)) return null;
      if (retryRefused(current, artifact, input.retry)) return "refused";
      return queueNotebookPreparation(tx, artifact, actor.userId, {
        force: true,
      });
    },
  );
  if (payload !== "refused") await requestNotebookPreparation([payload]);
  const overview = await getArtifactNotebook(db, actor, input, options);
  return payload === "refused" ? { ...overview, retryRefused: true } : overview;
}

export async function listArtifactNotebookPages(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput & {
    sectionId?: string;
    query?: string;
    matchCase?: boolean;
    offset?: number;
    limit?: number;
  },
  options: Options = {},
) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.query && input.query.length > 500)
  )
    throw new CoreError("BAD_REQUEST", "Invalid notebook page query");
  const snapshot = await readySnapshot(db, actor, input, options);
  const normalize = (text: string) =>
    input.matchCase ? text : text.toLocaleLowerCase();
  const query = input.query ? normalize(input.query) : undefined;
  if (
    input.sectionId &&
    !snapshot.manifest.sections.some((s) => s.id === input.sectionId)
  )
    throw new CoreError("NOT_FOUND", "Notebook section not found");
  const matches = snapshot.manifest.sections
    .filter((s) => !input.sectionId || s.id === input.sectionId)
    .flatMap((section) =>
      section.pages.map((page) => ({ ...page, sectionId: section.id })),
    )
    .filter(
      (page) =>
        !query || normalize(`${page.title}\n${page.text}`).includes(query),
    );
  const items = matches.slice(offset, offset + limit).map((page) => {
    const position = query
      ? Math.max(0, normalize(page.text).indexOf(query) - 80)
      : 0;
    return {
      id: page.id,
      sectionId: page.sectionId,
      title: page.title,
      level: page.level,
      ...(query ? { snippet: page.text.slice(position, position + 400) } : {}),
    };
  });
  await recheckSnapshot(db, actor, input, snapshot.state.claimToken);
  return {
    items,
    total: matches.length,
    nextOffset:
      offset + items.length < matches.length ? offset + items.length : null,
  };
}

export async function readArtifactNotebookPage(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput & { pageId: string },
  options: Options = {},
) {
  await checkRevision(db, actor, input);
  if (!notebookIdSchema.safeParse(input.pageId).success)
    throw new CoreError("BAD_REQUEST", "Invalid notebook page");
  const snapshot = await readySnapshot(db, actor, input, options);
  const section = snapshot.manifest.sections.find((section) =>
    section.pages.some((page) => page.id === input.pageId),
  );
  if (!section) throw new CoreError("NOT_FOUND", "Notebook page not found");
  let page;
  try {
    page = notebookPageSchema.parse(
      JSON.parse(
        (
          await readNotebookFile(
            snapshot.dataDir,
            path.join(snapshot.dir, "pages", `${input.pageId}.json`),
            NOTEBOOK_PAGE_MAX_BYTES,
          )
        ).toString("utf8"),
      ),
    );
    if (page.id !== input.pageId || page.sectionId !== section.id)
      throw unready();
  } catch {
    await invalidateSnapshot(db, snapshot.state);
    throw snapshotUnavailable();
  }
  await recheckSnapshot(db, actor, input, snapshot.state.claimToken);
  return page;
}

async function locateNotebookAsset(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput & { assetId: string },
  options: Options,
) {
  await checkRevision(db, actor, input);
  if (!notebookDigestSchema.safeParse(input.assetId).success)
    throw new CoreError("BAD_REQUEST", "Invalid notebook asset");
  const snapshot = await readySnapshot(db, actor, input, options);
  const asset = snapshot.manifest.assets.find(
    (asset) => asset.id === input.assetId,
  );
  if (!asset) throw new CoreError("NOT_FOUND", "Notebook asset not found");
  return { snapshot, asset };
}

/** The manifest entry of an image, checked like a read but without its bytes. */
export async function findArtifactNotebookAsset(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput & { assetId: string },
  options: Options = {},
): Promise<{ byteSize: number; contentType: string }> {
  const { asset } = await locateNotebookAsset(db, actor, input, options);
  return { byteSize: asset.byteSize, contentType: asset.contentType };
}

export async function readArtifactNotebookAsset(
  db: PrismaClient,
  actor: ProjectActor,
  input: RevisionInput & { assetId: string },
  options: Options = {},
) {
  const { snapshot, asset } = await locateNotebookAsset(
    db,
    actor,
    input,
    options,
  );
  let bytes: Buffer;
  try {
    bytes = await readNotebookFile(
      snapshot.dataDir,
      path.join(snapshot.dir, "assets", asset.id),
      NOTEBOOK_ASSET_MAX_BYTES,
    );
    if (
      bytes.length !== asset.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== asset.id ||
      !validImageSignature(bytes, asset.contentType)
    )
      throw unready();
  } catch {
    await invalidateSnapshot(db, snapshot.state);
    throw snapshotUnavailable();
  }
  await recheckSnapshot(db, actor, input, snapshot.state.claimToken);
  return { bytes, contentType: asset.contentType };
}
