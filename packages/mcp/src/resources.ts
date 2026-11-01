import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { sliceTextChunk } from "@weaver/assistant-tools/tools/snapshotReads";
import type { SourceLocator } from "@weaver/core/assistant/citations";
import {
  assertInScope,
  type ScopeSnapshot,
} from "@weaver/core/assistant/scope";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { DOCUMENT_KINDS } from "@weaver/core/documents/kinds";
import { isCoreError } from "@weaver/core/errors";
import type { SecurityContext } from "@weaver/core/security/context";
import { getDocumentAtSnapshot } from "@weaver/core/services/documents";
import { getGraphEntityDetail } from "@weaver/core/services/graph";
import { getTableAtSnapshot } from "@weaver/core/services/tables";
import type { PrismaClient } from "@weaver/db/client";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SHA = "[0-9a-f]{40}";
const DOCUMENT_RE = new RegExp(
  `^weaver://projects/(${UUID})/documents/(${UUID})(?:/revisions/(${SHA}))?$`,
);
const TABLE_RE = new RegExp(
  `^weaver://projects/(${UUID})/tables/(${UUID})(?:/revisions/(${SHA}))?$`,
);
const ENTITY_RE = new RegExp(
  `^weaver://projects/(${UUID})/entities/(${UUID})$`,
);

export const WEAVER_URI_TEMPLATES = {
  document: "weaver://projects/{projectId}/documents/{documentId}",
  documentRevision:
    "weaver://projects/{projectId}/documents/{documentId}/revisions/{commitSha}",
  table: "weaver://projects/{projectId}/tables/{tableId}",
  tableRevision:
    "weaver://projects/{projectId}/tables/{tableId}/revisions/{commitSha}",
  entity: "weaver://projects/{projectId}/entities/{entityId}",
} as const;

export type WeaverUri =
  | {
      kind: "document";
      projectId: string;
      documentId: string;
      revision?: string;
    }
  | { kind: "table"; projectId: string; tableId: string; revision?: string }
  | { kind: "entity"; projectId: string; entityId: string };

export function resourceUriFor(ref: WeaverUri): string {
  switch (ref.kind) {
    case "document":
      return `weaver://projects/${ref.projectId}/documents/${ref.documentId}${
        ref.revision ? `/revisions/${ref.revision}` : ""
      }`;
    case "table":
      return `weaver://projects/${ref.projectId}/tables/${ref.tableId}${
        ref.revision ? `/revisions/${ref.revision}` : ""
      }`;
    case "entity":
      return `weaver://projects/${ref.projectId}/entities/${ref.entityId}`;
  }
}

export function parseWeaverUri(uri: string): WeaverUri | null {
  const lower = uri.toLowerCase();
  const document = DOCUMENT_RE.exec(lower);
  if (document)
    return {
      kind: "document",
      projectId: document[1]!,
      documentId: document[2]!,
      ...(document[3] ? { revision: document[3] } : {}),
    };
  const table = TABLE_RE.exec(lower);
  if (table)
    return {
      kind: "table",
      projectId: table[1]!,
      tableId: table[2]!,
      ...(table[3] ? { revision: table[3] } : {}),
    };
  const entity = ENTITY_RE.exec(lower);
  if (entity)
    return {
      kind: "entity",
      projectId: entity[1]!,
      entityId: entity[2]!,
    };
  return null;
}

/** The resource a citation points at, if it names one by id. */
export function citationResource(citation: SourceLocator): WeaverUri | null {
  switch (citation.kind) {
    case "document":
      return {
        kind: "document",
        projectId: citation.projectId,
        documentId: citation.documentId,
      };
    case "table":
      return {
        kind: "table",
        projectId: citation.projectId,
        tableId: citation.tableId,
      };
    case "graph":
      return citation.entityId
        ? {
            kind: "entity",
            projectId: citation.projectId,
            entityId: citation.entityId,
          }
        : null;
    case "search":
      return citation.resourceType === "document"
        ? {
            kind: "document",
            projectId: citation.projectId,
            documentId: citation.resourceId,
          }
        : {
            kind: "table",
            projectId: citation.projectId,
            tableId: citation.resourceId,
          };
    case "aggregate":
      // An aggregate's citation kind is "table" (design §8.5): it names the
      // table the computation ran over, same as the "table" case above.
      return {
        kind: "table",
        projectId: citation.projectId,
        tableId: citation.tableId,
      };
  }
}

export const RESOURCE_MIME: Record<WeaverUri["kind"], string> = {
  document: "text/markdown",
  table: "application/json",
  entity: "application/json",
};

const MAX_RESOURCE_ROWS = 500;

export type ResourceAuditEvent = {
  name: string;
  projectId: string | null;
  outcome: "ok" | "error" | "denied";
  errorCode: string | null;
  durationMs: number;
};

export type ResourceDeps = {
  db: PrismaClient;
  actor: SecurityContext;
  scope: () => Promise<ScopeSnapshot>;
  maxResourceChars: number;
  /** Returns true only for the callback that owns the request's audit slot. */
  onAudit: (event: ResourceAuditEvent) => Promise<boolean>;
};

export function emitMcpResourceDiagnostic(input: {
  ref: WeaverUri | null;
  outcome: ResourceAuditEvent["outcome"];
  errorCode: string | null;
  durationMs: number;
}): void {
  const { ref, outcome, errorCode, durationMs } = input;
  emitDiagnostic({
    event: "mcp.resource.read",
    severity: outcome === "ok" ? "info" : "warn",
    message: `${ref?.kind ?? "resource"} ${outcome}`,
    durationMs,
    outcome,
    projectId: ref?.projectId,
    documentId: ref?.kind === "document" ? ref.documentId : undefined,
    details: {
      kind: ref?.kind ?? null,
      uri: ref ? resourceUriFor(ref) : null,
      code: errorCode,
    },
  });
}

function cappedText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  const { text: sliced, end } = sliceTextChunk(text, 0, max);
  return { text: sliced, truncated: end < text.length };
}

function cappedJson(
  value: unknown,
  max: number,
): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value);
  if (serialized.length <= max) return { text: serialized, truncated: false };

  let low = 0;
  let high = serialized.length;
  let text = JSON.stringify({ truncated: true, partialJson: "" });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      truncated: true,
      originalChars: serialized.length,
      partialJson: serialized.slice(0, middle),
    });
    if (candidate.length <= max) {
      text = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text, truncated: true };
}

const COMPLETE_READS = {
  columns: "list_table_columns",
  options: "list_table_column_options",
  rows: "query_table_rows",
  cell: "read_table_cell",
} as const;

async function readWeaverResource(
  ref: WeaverUri,
  deps: ResourceDeps,
): Promise<{
  mimeType: string;
  text: string;
  truncated: boolean;
  meta: Record<string, string | boolean>;
}> {
  switch (ref.kind) {
    case "document": {
      const document = await getDocumentAtSnapshot(
        deps.db,
        {
          projectId: ref.projectId,
          documentId: ref.documentId,
          atCommitSha: ref.revision,
        },
        deps.actor,
      );
      const body = cappedText(document.markdown, deps.maxResourceChars);
      return {
        mimeType: DOCUMENT_KINDS[document.kind].mimeType,
        ...body,
        meta: revisionMeta(ref, document),
      };
    }
    case "table": {
      const table = await getTableAtSnapshot(
        deps.db,
        {
          projectId: ref.projectId,
          tableId: ref.tableId,
          atCommitSha: ref.revision,
        },
        deps.actor,
      );
      const payload = {
        id: table.id,
        title: table.title,
        path: table.path,
        commitSha: table.baseCommitSha,
        snapshotCommitSha: table.snapshotCommitSha,
        baseCommitSha: table.baseCommitSha,
        columnCount: table.columns.length,
        columns: table.columns,
        rowCount: table.rowCount,
        rows: table.rows.slice(0, MAX_RESOURCE_ROWS),
        rowsTruncated: table.rows.length > MAX_RESOURCE_ROWS,
        completeReads: COMPLETE_READS,
      };
      const body = cappedJson(payload, deps.maxResourceChars);
      return {
        mimeType: RESOURCE_MIME.table,
        ...body,
        meta: revisionMeta(ref, table),
      };
    }
    case "entity": {
      const detail = await getGraphEntityDetail(
        deps.db,
        { entityId: ref.entityId },
        deps.actor,
      );
      // The URI names the project; an id that belongs elsewhere is "not found",
      // never a hint that it exists.
      if (detail.entity.projectId !== ref.projectId)
        throw new ResourceNotFoundError(resourceUriFor(ref));
      const body = cappedJson(detail, deps.maxResourceChars);
      return { mimeType: RESOURCE_MIME.entity, ...body, meta: {} };
    }
  }
}

function revisionMeta(
  ref: Extract<WeaverUri, { kind: "document" | "table" }>,
  revisions: { snapshotCommitSha: string; baseCommitSha: string },
): Record<string, string> {
  const { revision: _omit, ...live } = ref;
  return {
    "net.weaver/snapshotCommitSha": revisions.snapshotCommitSha,
    "net.weaver/baseCommitSha": revisions.baseCommitSha,
    "net.weaver/revisionUri": resourceUriFor({
      ...live,
      revision: revisions.snapshotCommitSha,
    }),
  };
}

export function registerResources(server: McpServer, deps: ResourceDeps): void {
  const read = async (uri: URL): Promise<ReadResourceResult> => {
    const started = Date.now();
    const ref = parseWeaverUri(uri.href);
    const audit = async (
      outcome: "ok" | "error" | "denied",
      errorCode: string | null,
    ) => {
      const durationMs = Date.now() - started;
      const ownsAudit = await deps.onAudit({
        name: uri.href,
        projectId: ref?.projectId ?? null,
        outcome,
        errorCode,
        durationMs,
      });
      if (!ownsAudit) return;
      emitMcpResourceDiagnostic({ ref, outcome, errorCode, durationMs });
    };
    if (!ref) {
      await audit("error", "NOT_FOUND");
      throw new ResourceNotFoundError(uri.href);
    }
    try {
      assertInScope(await deps.scope(), ref.projectId);
      const result = await readWeaverResource(ref, deps);
      await audit("ok", null);
      return {
        contents: [
          { uri: uri.href, mimeType: result.mimeType, text: result.text },
        ],
        _meta: { "net.weaver/truncated": result.truncated, ...result.meta },
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        await audit("error", "NOT_FOUND");
        throw error;
      }
      if (
        isCoreError(error) &&
        (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
      ) {
        // Spec resources §6: missing and hidden look the same.
        await audit(
          error.code === "FORBIDDEN" ? "denied" : "error",
          error.code,
        );
        throw new ResourceNotFoundError(uri.href);
      }
      await audit("error", isCoreError(error) ? error.code : "INTERNAL");
      throw error;
    }
  };
  const cacheHint = { ttlMs: 0, cacheScope: "private" as const };
  server.registerResource(
    "weaver-document",
    new ResourceTemplate(WEAVER_URI_TEMPLATES.document, { list: undefined }),
    {
      title: "Weaver document",
      description: "A document's Markdown at its current committed revision.",
      mimeType: RESOURCE_MIME.document,
      cacheHint,
    },
    (uri) => read(uri),
  );
  server.registerResource(
    "weaver-document-revision",
    new ResourceTemplate(WEAVER_URI_TEMPLATES.documentRevision, {
      list: undefined,
    }),
    {
      title: "Weaver document at a revision",
      description:
        "A document's Markdown at the given project snapshot commit; never falls back to current content.",
      mimeType: RESOURCE_MIME.document,
      cacheHint,
    },
    (uri) => read(uri),
  );
  server.registerResource(
    "weaver-table",
    new ResourceTemplate(WEAVER_URI_TEMPLATES.table, { list: undefined }),
    {
      title: "Weaver table",
      description:
        "A table's schema, row count, first rows, and commit as JSON.",
      mimeType: RESOURCE_MIME.table,
      cacheHint,
    },
    (uri) => read(uri),
  );
  server.registerResource(
    "weaver-table-revision",
    new ResourceTemplate(WEAVER_URI_TEMPLATES.tableRevision, {
      list: undefined,
    }),
    {
      title: "Weaver table at a revision",
      description:
        "A table's schema, row count, and first rows at the given project snapshot commit as JSON.",
      mimeType: RESOURCE_MIME.table,
      cacheHint,
    },
    (uri) => read(uri),
  );
  server.registerResource(
    "weaver-entity",
    new ResourceTemplate(WEAVER_URI_TEMPLATES.entity, { list: undefined }),
    {
      title: "Weaver graph entity",
      description:
        "A knowledge-graph entity with aliases and supporting mentions as JSON.",
      mimeType: RESOURCE_MIME.entity,
      cacheHint,
    },
    (uri) => read(uri),
  );
}
