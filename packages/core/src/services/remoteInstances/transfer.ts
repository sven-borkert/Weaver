import { readAppearanceAsset } from "../appearanceAssets";
import type { Appearance } from "../../appearance/metadata";
import type { TransferAppearance } from "./types";
import type { PrismaClient } from "@weaver/db/client";
import { summarizeError } from "../../diagnostics/errorSummary";
import { emitDiagnostic } from "../../diagnostics/writer";
import { crossrefsToText } from "../../documents/crossrefText";
import {
  assetsDirForDocPath,
  collectImageSources,
  resolveRelativeImagePath,
} from "../../documents/images";
import { documentFileStem } from "../../documents/kinds";
import { extractCrossrefTargets } from "../../documents/links";
import {
  crossrefTargetKey,
  parseDocumentBody,
  serializeDocumentBody,
} from "../../editor/markdown";
import { CoreError, isCoreError } from "../../errors";
import { remoteJson, RemoteHttpError } from "../../remotes/http";
import { remoteEndpoints } from "../../remotes/urls";
import type { UserSecurityContext } from "../../security/context";
import type { TableColumn, TableRow } from "../../tables/types";
import { readProjectImage } from "../documentImages";
import { getDocumentAtSnapshot, resolveRefs } from "../documents";
import type { ProjectActor } from "../projectAccess";
import { getTable } from "../tables";
import { withRemoteToken } from "./connections";
import {
  TRANSFER_BODY_MAX_BYTES,
  TRANSFER_IMAGE_NAME_RE,
  TRANSFER_MAX_IMAGES,
} from "./receive";
import type { RemoteRuntimeDeps } from "./types";

/** Leaves room under B's body cap for base64 growth plus the Markdown. */
export const TRANSFER_MAX_IMAGE_BYTES_TOTAL = 46 * 1024 * 1024;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const SEND_TIMEOUT_MS = 60_000;
const MAX_REMOTE_DETAIL_CHARS = 300;

type Remote = { id: string; name: string; baseUrl: string };
type FolderTree = { folders: string[]; folderNames: Record<string, string> };
type SendResult = { id: string; path: string; url: string };

export async function buildDocumentTransferPayload(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; documentId: string },
): Promise<
  {
    title: string;
    markdown: string;
    assetsSlug: string;
    images: Array<{ name: string; contentType: string; bytes: string }>;
  } & TransferAppearance
> {
  const document = await getDocumentAtSnapshot(
    db,
    { projectId: input.projectId, documentId: input.documentId },
    actor,
  );
  if (document.kind !== "markdown")
    throw new CoreError(
      "BAD_REQUEST",
      "Only Markdown documents can be sent to another Weaver",
    );
  let json = parseDocumentBody(document.markdown);
  const targets = extractCrossrefTargets(json);
  if (targets.length) {
    const rows = await resolveRefs(
      db,
      { projectId: input.projectId, ids: targets.map((t) => t.targetId) },
      actor,
    );
    const titles = new Map<string, string>();
    for (const row of rows)
      if (row.exists)
        titles.set(crossrefTargetKey(row.targetType, row.id), row.title);
    json = crossrefsToText(json, titles);
  }
  const assetsDir = `${assetsDirForDocPath(document.path)}/`;
  const assetsSlug = documentFileStem(document.path);
  const images: Array<{ name: string; contentType: string; bytes: string }> =
    [];
  const portable = await transferAppearance(
    db,
    actor,
    input.projectId,
    document.appearance,
    document.snapshotCommitSha,
  );
  let total =
    portable.iconAssets?.reduce(
      (sum, asset) => sum + Buffer.from(asset.bytes, "base64").byteLength,
      0,
    ) ?? 0;
  for (const src of new Set(collectImageSources(json))) {
    const relPath = resolveRelativeImagePath(document.path, src);
    if (!relPath?.startsWith(assetsDir)) continue; // only the document's own assets travel
    const name = relPath.slice(assetsDir.length);
    // B refuses the whole document for one such name; the link stays as written.
    if (
      !TRANSFER_IMAGE_NAME_RE.test(name) ||
      images.some((i) => i.name === name)
    )
      continue;
    const served = await readProjectImage(
      db,
      {
        projectId: input.projectId,
        segments: relPath.split("/"),
        at: document.baseCommitSha,
      },
      actor,
    );
    if (!served) continue;
    total += served.bytes.byteLength;
    if (
      images.length >= TRANSFER_MAX_IMAGES ||
      total > TRANSFER_MAX_IMAGE_BYTES_TOTAL
    )
      throw new CoreError(
        "BAD_REQUEST",
        "This document has too many or too large images to send",
      );
    images.push({
      name,
      contentType: served.contentType,
      bytes: Buffer.from(served.bytes).toString("base64"),
    });
  }
  return {
    ...portable,
    title: document.title,
    markdown: serializeDocumentBody(json),
    assetsSlug,
    images,
  };
}

export async function buildTableTransferPayload(
  db: PrismaClient,
  actor: ProjectActor,
  input: { projectId: string; tableId: string },
): Promise<
  {
    title: string;
    columns: TableColumn[];
    rows: TableRow[];
  } & TransferAppearance
> {
  const table = await getTable(
    db,
    { projectId: input.projectId, tableId: input.tableId },
    actor,
  );
  return {
    title: table.title,
    columns: table.columns,
    rows: table.rows,
    ...(await transferAppearance(
      db,
      actor,
      input.projectId,
      table.appearance,
      table.snapshotCommitSha,
    )),
  };
}

async function transferAppearance(
  db: PrismaClient,
  actor: ProjectActor,
  projectId: string,
  appearance: Appearance | null,
  revision: string,
): Promise<TransferAppearance> {
  if (!appearance) return {};
  const icon = appearance.icon;
  if (icon?.type !== "image") return { appearance };
  const asset = await readAppearanceAsset(
    db,
    { projectId, icon, at: revision },
    actor,
  );
  if (!asset || !("bytes" in asset))
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The item's icon is unavailable",
    );
  return {
    appearance,
    iconAssets: [
      {
        digest: icon.digest,
        extension: icon.extension,
        bytes: Buffer.from(asset.bytes).toString("base64"),
      },
    ],
  };
}

/** B's `{ error }` text, bounded; B is another Weaver, so its messages are user-facing. */
function remoteDetail(error: RemoteHttpError): string {
  try {
    const detail = (JSON.parse(error.bodyText) as { error?: unknown }).error;
    return typeof detail === "string"
      ? detail.slice(0, MAX_REMOTE_DETAIL_CHARS)
      : "";
  } catch {
    return "";
  }
}

type RemoteErrorContext = {
  operation: "targets" | "folders" | "document" | "table";
  projectId?: string;
  documentId?: string;
};

function mapRemoteError(
  error: unknown,
  context: RemoteErrorContext & { actor: UserSecurityContext; remote: Remote },
): never {
  const { remote } = context;
  emitDiagnostic({
    severity: "warn",
    event: "remote.transfer.failed",
    message: "request to remote instance failed",
    userId: context.actor.userId,
    projectId: context.projectId,
    documentId: context.documentId,
    details: {
      remoteInstanceId: remote.id,
      operation: context.operation,
      status: error instanceof RemoteHttpError ? error.status : null,
      error: summarizeError(error),
    },
  });
  if (isCoreError(error)) throw error;
  // 5xx CoreErrors lose their message in production, so every remote failure is 4xx.
  if (error instanceof RemoteHttpError) {
    const detail = remoteDetail(error);
    const suffix = detail ? `: ${detail}` : "";
    switch (error.status) {
      case 401:
        // Same shape as withRemoteToken's reconnect error: the one reconnect signal.
        throw new CoreError(
          "PRECONDITION_FAILED",
          `Reconnect to ${remote.name}`,
          {
            field: "remoteInstanceId",
          },
        );
      case 403:
        throw new CoreError(
          "FORBIDDEN",
          context.operation === "targets" || context.operation === "folders"
            ? `You cannot list projects on ${remote.name}${suffix}`
            : `You cannot write to that project on ${remote.name}${suffix}`,
        );
      case 404:
        throw new CoreError(
          "NOT_FOUND",
          `${remote.name} did not find that project or folder`,
        );
      case 400:
      case 413:
        throw new CoreError(
          "BAD_REQUEST",
          `${remote.name} refused the content${suffix}`,
        );
      case 409:
        throw new CoreError(
          "CONFLICT",
          `${remote.name} reported a conflict${suffix}`,
        );
      case 412:
        throw new CoreError(
          "PRECONDITION_FAILED",
          `${remote.name} cannot accept this right now${suffix}`,
        );
      case 429:
        throw new CoreError(
          "TOO_MANY_REQUESTS",
          `${remote.name} is receiving too many requests${suffix}`,
        );
    }
    throw new CoreError(
      "PRECONDITION_FAILED",
      `${remote.name} answered with an error (${error.status}).`,
    );
  }
  if (error instanceof SyntaxError) throw unexpectedReply(remote);
  // Network, timeout and outbound-policy failures; the cause stays in diagnostics.
  throw new CoreError(
    "PRECONDITION_FAILED",
    `${remote.name} could not be reached. Try again later.`,
  );
}

/** Calls B with the user's token; refresh and request failures both become user-facing errors. */
function withRemote<T>(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  remoteInstanceId: string,
  context: RemoteErrorContext,
  request: (
    token: string,
    remote: Remote,
    fetchImpl: typeof fetch,
  ) => Promise<T>,
): Promise<T> {
  return withRemoteToken(
    deps,
    { userId: actor.userId, remoteInstanceId },
    request,
    (error, remote) => mapRemoteError(error, { ...context, actor, remote }),
  );
}

const unexpectedReply = (remote: Remote) =>
  new CoreError(
    "PRECONDITION_FAILED",
    `${remote.name} did not answer like a Weaver instance.`,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readFolderTree(value: unknown): FolderTree {
  const tree = isRecord(value) ? value : {};
  const folders = Array.isArray(tree.folders)
    ? tree.folders.filter((f): f is string => typeof f === "string")
    : [];
  const folderNames: Record<string, string> = {};
  if (isRecord(tree.folderNames))
    for (const [path, name] of Object.entries(tree.folderNames))
      if (typeof name === "string") folderNames[path] = name;
  return { folders, folderNames };
}

export async function fetchTransferTargets(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  input: { remoteInstanceId: string },
): Promise<{ projects: Array<{ id: string; name: string; myRole: string }> }> {
  return withRemote(
    deps,
    actor,
    input.remoteInstanceId,
    { operation: "targets" },
    (token, remote, fetchImpl) =>
      remoteJson<unknown>(
        fetchImpl,
        remoteEndpoints(remote.baseUrl).transfer("targets"),
        {
          headers: { authorization: `Bearer ${token}` },
          maxBytes: LIST_MAX_BYTES,
        },
      ).then((reply) => {
        if (!isRecord(reply) || !Array.isArray(reply.projects))
          throw unexpectedReply(remote);
        return {
          projects: reply.projects.filter(isRecord).flatMap((project) =>
            typeof project.id === "string" && typeof project.name === "string"
              ? [
                  {
                    id: project.id,
                    name: project.name,
                    myRole:
                      typeof project.myRole === "string" ? project.myRole : "",
                  },
                ]
              : [],
          ),
        };
      }),
  );
}

export async function fetchTransferTargetFolders(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  input: { remoteInstanceId: string; projectId: string },
): Promise<{ documents: FolderTree; tables: FolderTree }> {
  return withRemote(
    deps,
    actor,
    input.remoteInstanceId,
    { operation: "folders" },
    (token, remote, fetchImpl) =>
      remoteJson<unknown>(
        fetchImpl,
        remoteEndpoints(remote.baseUrl).transfer(
          `targets/${encodeURIComponent(input.projectId)}`,
        ),
        {
          headers: { authorization: `Bearer ${token}` },
          maxBytes: LIST_MAX_BYTES,
        },
      ).then((reply) => {
        if (!isRecord(reply)) throw unexpectedReply(remote);
        return {
          documents: readFolderTree(reply.documents),
          tables: readFolderTree(reply.tables),
        };
      }),
  );
}

/** The request body, refused here when B's body cap would refuse it anyway. */
export function transferRequestBody(payload: unknown): string {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > TRANSFER_BODY_MAX_BYTES)
    throw new CoreError("BAD_REQUEST", "This item is too large to send");
  return body;
}

async function post(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  input: {
    remoteInstanceId: string;
    projectId: string;
    targetProjectId: string;
    documentId?: string;
  },
  kind: "documents" | "tables",
  payload: unknown,
): Promise<SendResult> {
  const body = transferRequestBody(payload);
  return withRemote(
    deps,
    actor,
    input.remoteInstanceId,
    {
      operation: kind === "documents" ? "document" : "table",
      projectId: input.projectId,
      documentId: input.documentId,
    },
    async (token, remote, fetchImpl) => {
      const appearance = (payload as TransferAppearance).appearance;
      if (appearance?.icon?.type === "image") {
        const who = await remoteJson<unknown>(
          fetchImpl,
          remoteEndpoints(remote.baseUrl).transfer("whoami"),
          {
            headers: { authorization: `Bearer ${token}` },
            maxBytes: LIST_MAX_BYTES,
          },
        );
        if (
          !isRecord(who) ||
          !isRecord(who.capabilities) ||
          who.capabilities.contentAppearance !== 1
        )
          throw new CoreError(
            "PRECONDITION_FAILED",
            "This instance does not support image appearance transfers",
          );
      }
      return remoteJson<unknown>(
        fetchImpl,
        remoteEndpoints(remote.baseUrl).transfer(kind),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
          timeoutMs: SEND_TIMEOUT_MS,
        },
      ).then((reply): SendResult => {
        if (
          !isRecord(reply) ||
          typeof reply.id !== "string" ||
          typeof reply.path !== "string"
        )
          throw unexpectedReply(remote);
        const url = `${remote.baseUrl}/projects/${encodeURIComponent(input.targetProjectId)}/${kind}/${encodeURIComponent(reply.id)}`;
        return { id: reply.id, path: reply.path, url };
      });
    },
  );
}

export async function sendDocumentToRemote(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  input: {
    remoteInstanceId: string;
    projectId: string;
    documentId: string;
    targetProjectId: string;
    targetFolderPath: string[];
  },
): Promise<SendResult> {
  const payload = await buildDocumentTransferPayload(deps.db, actor, input);
  return post(deps, actor, input, "documents", {
    projectId: input.targetProjectId,
    folderPath: input.targetFolderPath,
    ...payload,
  });
}

export async function sendTableToRemote(
  deps: RemoteRuntimeDeps,
  actor: UserSecurityContext,
  input: {
    remoteInstanceId: string;
    projectId: string;
    tableId: string;
    targetProjectId: string;
    targetFolderPath: string[];
  },
): Promise<SendResult> {
  const payload = await buildTableTransferPayload(deps.db, actor, input);
  return post(deps, actor, input, "tables", {
    projectId: input.targetProjectId,
    folderPath: input.targetFolderPath,
    ...payload,
  });
}
