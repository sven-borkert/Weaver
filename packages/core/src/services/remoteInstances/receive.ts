import {
  assertAppearancePatch,
  normalizeAppearance,
} from "../../appearance/metadata";
import { validateAppearanceAssets } from "../appearanceAssets";
import type { TransferAppearance } from "./types";
import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../../diagnostics/writer";
import { parseDocumentBody } from "../../editor/markdown";
import { DOCUMENT_IMAGE_TYPES, sniffImageType } from "../../documents/images";
import { MAX_MARKDOWN_CHARS } from "../../documents/limits";
import { CoreError } from "../../errors";
import { baseUrlFromClientId } from "../../remotes/urls";
import { projectRoleAtLeast, type ProjectRoleName } from "../../roles";
import {
  hasCapability,
  type UserSecurityContext,
} from "../../security/context";
import type { TableColumn, TableRow } from "../../tables/types";
import {
  createDocument,
  type DocumentAssetFile,
  type EnrichedActor,
} from "../documents";
import { getTree as getDocumentTree } from "../folders";
import { assertProjectRole, type ProjectActor } from "../projectAccess";
import { listProjectsForUser } from "../projects";
import { getTree as getTableTree } from "../tableFolders";
import { createTable } from "../tables";

export const TRANSFER_IMAGE_NAME_RE =
  /^[a-z0-9][a-z0-9-]{0,79}\.(png|jpg|webp|gif)$/;
export const TRANSFER_MAX_IMAGES = 100;
export const TRANSFER_BODY_MAX_BYTES = 64 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export type TransferredImage = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export async function listTransferTargets(
  db: PrismaClient,
  actor: UserSecurityContext,
): Promise<Array<{ id: string; name: string; myRole: ProjectRoleName }>> {
  if (!hasCapability(actor, "content:write")) return [];
  const projects = await listProjectsForUser(db, actor);
  return projects
    .filter((project) => projectRoleAtLeast(project.myRole, "Editor"))
    .map((project) => ({
      id: project.id,
      name: project.name,
      myRole: project.myRole,
    }));
}

export async function transferTargetFolders(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
): Promise<{
  documents: { folders: string[]; folderNames: Record<string, string> };
  tables: { folders: string[]; folderNames: Record<string, string> };
}> {
  await assertProjectRole(db, projectId, actor, "Editor");
  const [documents, tables] = await Promise.all([
    getDocumentTree(db, { projectId }, actor, "documents"),
    getTableTree(db, { projectId }, actor),
  ]);
  return {
    documents: {
      folders: documents.folders,
      folderNames: documents.folderNames,
    },
    tables: { folders: tables.folders, folderNames: tables.folderNames },
  };
}

const bad = (message: string, field: string) =>
  new CoreError("BAD_REQUEST", message, { field });

function transferOperationId(fromClientId: string | null): string | undefined {
  const origin = fromClientId ? baseUrlFromClientId(fromClientId) : null;
  const id = origin ? `remote-transfer:${origin}` : undefined;
  // Git refuses operation ids over 200 characters; a very long base URL loses the trailer.
  return id && id.length <= 200 ? id : undefined;
}

function received(
  input: {
    projectId: string;
    kind: "document" | "table";
    id: string;
    fromClientId: string | null;
  },
  actor: UserSecurityContext,
) {
  emitDiagnostic({
    severity: "info",
    event: "content.transfer.received",
    message: `${input.kind} received from another Weaver instance`,
    projectId: input.projectId,
    userId: actor.userId,
    details: {
      kind: input.kind,
      id: input.id,
      from: input.fromClientId ? baseUrlFromClientId(input.fromClientId) : null,
    },
  });
}

export async function receiveTransferredDocument(
  db: PrismaClient,
  actor: EnrichedActor,
  input: {
    fromClientId: string | null;
    projectId: string;
    folderPath: string[];
    title: string;
    markdown: string;
    assetsSlug: string;
    images: TransferredImage[];
  } & TransferAppearance,
  limits: { maxImageBytes: number },
): Promise<{ id: string; path: string; slug: string }> {
  if (input.markdown.length > MAX_MARKDOWN_CHARS)
    throw bad("Markdown exceeds the size limit", "markdown");
  if (!SLUG_RE.test(input.assetsSlug))
    throw bad("assetsSlug is not a slug", "assetsSlug");
  if (input.images.length > TRANSFER_MAX_IMAGES)
    throw new CoreError(
      "BAD_REQUEST",
      `at most ${TRANSFER_MAX_IMAGES} images per document`,
      { field: "images", reason: "PAYLOAD_TOO_LARGE" },
    );
  const names = new Set<string>();
  const assets: DocumentAssetFile[] = [];
  for (const image of input.images) {
    if (!TRANSFER_IMAGE_NAME_RE.test(image.name) || names.has(image.name))
      throw bad(
        `image name ${image.name.slice(0, 80)} is invalid or repeated`,
        "images",
      );
    if (image.bytes.byteLength > limits.maxImageBytes)
      throw new CoreError(
        "BAD_REQUEST",
        `image ${image.name} exceeds the image size limit`,
        { field: "images", reason: "PAYLOAD_TOO_LARGE" },
      );
    const sniffed = sniffImageType(image.bytes.subarray(0, 16));
    if (
      !sniffed ||
      !(DOCUMENT_IMAGE_TYPES as readonly string[]).includes(
        image.contentType,
      ) ||
      sniffed !== image.contentType
    )
      throw bad(
        `image ${image.name} is not the ${image.contentType} it claims to be`,
        "images",
      );
    names.add(image.name);
    assets.push({ name: image.name, bytes: image.bytes });
  }
  const created = await createDocument(
    db,
    {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title: input.title,
      content: {
        kind: "markdown",
        contentJson: parseDocumentBody(input.markdown),
      },
      reviewSource: { kind: "import", imported: null },
      assets,
      assetsFromSlug: input.assetsSlug,
      ...receivedAppearance(input),
    },
    actor,
    { operationId: transferOperationId(input.fromClientId) },
  );
  received(
    {
      projectId: input.projectId,
      kind: "document",
      id: created.id,
      fromClientId: input.fromClientId,
    },
    actor,
  );
  return { id: created.id, path: created.path, slug: created.slug };
}

export async function receiveTransferredTable(
  db: PrismaClient,
  actor: EnrichedActor,
  input: {
    fromClientId: string | null;
    projectId: string;
    folderPath: string[];
    title: string;
    columns: TableColumn[];
    rows: TableRow[];
  } & TransferAppearance,
): Promise<{ id: string; path: string; slug: string }> {
  if (!input.columns.length)
    throw bad("a table needs at least one column", "columns");
  const created = await createTable(
    db,
    {
      projectId: input.projectId,
      folderPath: input.folderPath,
      title: input.title,
      columns: input.columns,
      rows: input.rows,
      ...receivedAppearance(input),
    },
    actor,
  );
  received(
    {
      projectId: input.projectId,
      kind: "table",
      id: created.id,
      fromClientId: input.fromClientId,
    },
    actor,
  );
  return { id: created.id, path: created.path, slug: created.slug };
}

function receivedAppearance(input: TransferAppearance) {
  if (input.appearance !== undefined) assertAppearancePatch(input.appearance);
  const appearance = normalizeAppearance(input.appearance) ?? undefined;
  const iconAssets = (input.iconAssets ?? []).map((asset) => ({
    ...asset,
    bytes: Buffer.from(asset.bytes, "base64"),
  }));
  validateAppearanceAssets(iconAssets);
  if (
    iconAssets.some(
      (asset) =>
        appearance?.icon?.type !== "image" ||
        asset.digest !== appearance.icon.digest ||
        asset.extension !== appearance.icon.extension,
    )
  )
    throw bad("Unreferenced icon asset", "iconAssets");
  return { appearance, iconAssets };
}
