import { z } from "zod";
import { diagnosticsSettingsPatchSchema } from "@weaver/core/diagnostics/settings";
import {
  DIAGNOSTIC_LIST_MAX,
  encodeDiagnosticEventCursor,
  getDiagnosticEvent,
  listDiagnosticEvents,
  pruneDiagnosticEventsAsAdmin,
} from "@weaver/core/services/diagnosticEvents";
import {
  diagnosticsStats,
  getDiagnosticsSettings,
  setDiagnosticsSettings,
} from "@weaver/core/services/diagnosticsSettings";
import {
  encodeChangeSummaryCursor,
  listDocumentChangeSummaries,
} from "@weaver/core/services/documentChangeSummaryInspection";
import { retentionSettingsPatchSchema } from "@weaver/core/diagnostics/retentionSettings";
import {
  getRetentionSettings,
  setRetentionSettings,
} from "@weaver/core/services/retentionSettings";
import { MAX_TOOL_OUTPUT_CHARS, defineTool, utf8Bytes } from "../../contract";

const severities = ["debug", "info", "warn", "error"] as const;
const isoDate = z.iso.datetime({ offset: true });
import { listInput, pagedOutput } from "./paging";

type DiagnosticEventOutput = Awaited<ReturnType<typeof getDiagnosticEvent>>;

function sourcePrefix(text: string, length: number): string {
  let end = Math.min(Math.max(Math.trunc(length), 0), text.length);
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

function boundDiagnosticEventOutput(
  output: DiagnosticEventOutput,
): DiagnosticEventOutput {
  if (
    utf8Bytes(JSON.stringify(output)) <= MAX_TOOL_OUTPUT_CHARS ||
    !output.body
  ) {
    return output;
  }

  let low = 0;
  let high = output.body.text.length;
  let bounded: DiagnosticEventOutput = {
    ...output,
    body: { ...output.body, text: "", nextOffset: output.body.offset },
  };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = sourcePrefix(output.body.text, middle);
    const candidate = {
      ...output,
      body: {
        ...output.body,
        text,
        nextOffset:
          text.length < output.body.text.length
            ? output.body.offset + text.length
            : output.body.nextOffset,
      },
    };
    if (utf8Bytes(JSON.stringify(candidate)) <= MAX_TOOL_OUTPUT_CHARS) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return bounded;
}

export const getDiagnosticsSettingsTool = defineTool({
  name: "get_diagnostics_settings",
  description:
    "Read the diagnostic log level (off, errors, standard, verbose), retention, row cap, and table statistics.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const [settings, stats] = await Promise.all([
      getDiagnosticsSettings(ctx.db),
      diagnosticsStats(ctx.db, ctx.actor),
    ]);
    return { output: { settings, stats } };
  },
});

export const setDiagnosticsSettingsTool = defineTool({
  name: "set_diagnostics_settings",
  description:
    "Change the diagnostic log level or retention. Errors keeps only warnings and failures. Verbose stores provider request and response bodies, which may contain private project content and require membership to read, for the verbose retention window.",
  kind: "write",
  capability: "system:admin",
  inputSchema: diagnosticsSettingsPatchSchema,
  async execute(input, ctx) {
    const settings = await setDiagnosticsSettings(ctx.db, ctx.actor, input);
    return { output: { settings } };
  },
});

export const getRetentionSettingsTool = defineTool({
  name: "get_retention_settings",
  description:
    "Read how many days finished import batches, idle assistant conversations (0 = keep forever), scheduled task runs and AI usage records are retained.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { output: { settings: await getRetentionSettings(ctx.db) } };
  },
});

export const setRetentionSettingsTool = defineTool({
  name: "set_retention_settings",
  description:
    "Change retention periods in days: ingestionDays 1–365, assistantConversationDays 0–730 (0 keeps conversations), taskRunDays 1–365, aiUsageDays 1–730. Cleanup is bounded per reconcile pass and never touches active work.",
  kind: "write",
  capability: "system:admin",
  inputSchema: retentionSettingsPatchSchema,
  async execute(input, ctx) {
    return {
      output: {
        settings: await setRetentionSettings(ctx.db, ctx.actor, input),
      },
    };
  },
});

const reference = z.string().regex(/^[0-9a-fA-F]{8}$/);

export const listDiagnosticEventsTool = defineTool({
  name: "list_diagnostic_events",
  description:
    "List diagnostic events newest first. Filter by time, category, event, severity, any correlation id, or an 8-character reference from a user-facing error message; page with cursor. Bodies are excluded; use get_diagnostic_event.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    since: isoDate.optional(),
    until: isoDate.optional(),
    category: z.string().max(40).optional(),
    event: z.string().max(80).optional(),
    severity: z.enum(severities).optional(),
    reference: reference.optional(),
    requestId: z.string().max(64).optional(),
    jobId: z.string().max(64).optional(),
    runId: z.uuid().optional(),
    userId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    generationId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    fileId: z.uuid().optional(),
    connectionId: z.uuid().optional(),
    text: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(DIAGNOSTIC_LIST_MAX).optional(),
    cursor: z.string().max(400).optional(),
  }),
  async execute(input, ctx) {
    const { since, until, ...filter } = input;
    const page = await listDiagnosticEvents(ctx.db, ctx.actor, {
      ...filter,
      ...(since ? { since: new Date(since) } : {}),
      ...(until ? { until: new Date(until) } : {}),
    });
    return { output: pagedOutput(page, encodeDiagnosticEventCursor) };
  },
});

export const getDiagnosticEventTool = defineTool({
  name: "get_diagnostic_event",
  description:
    "Read one diagnostic event by id or by the 8-character reference shown in error messages, optionally with a 12,000-character slice of its request or response body starting at offset.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z
    .object({
      id: z.uuid().optional(),
      reference: reference.optional(),
      body: z.enum(["none", "request", "response"]).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine((value) => (value.id ? 1 : 0) + (value.reference ? 1 : 0) === 1, {
      message: "Provide exactly one of id or reference",
    }),
  async execute(input, ctx) {
    return {
      output: boundDiagnosticEventOutput(
        await getDiagnosticEvent(ctx.db, ctx.actor, input),
      ),
    };
  },
});

export const listDocumentChangeSummariesTool = defineTool({
  name: "list_document_change_summaries",
  description:
    "Document change summary rows newest first: project, document and commit ids, status, failure reason, attempts, last error class, last job id, and timestamps. Metadata only; never summary text or paths. Filter by status, project, document, or since; page with cursor.",
  kind: "read",
  capability: "system:admin",
  inputSchema: z.object({
    status: z.enum(["pending", "ready", "failed", "skipped"]).optional(),
    projectId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    since: isoDate.optional(),
    ...listInput,
  }),
  async execute(input, ctx) {
    const { since, ...filter } = input;
    const page = await listDocumentChangeSummaries(ctx.db, ctx.actor, {
      ...filter,
      ...(since ? { since: new Date(since) } : {}),
    });
    return {
      output: pagedOutput(
        {
          items: page.items,
          nextCursor: page.nextCursor,
          truncated: page.truncated,
        },
        encodeChangeSummaryCursor,
      ),
    };
  },
});

export const pruneDiagnosticEventsTool = defineTool({
  name: "prune_diagnostic_events",
  description:
    "Run diagnostic housekeeping now: verbose rows past their hours, all rows past retention days, then rows beyond the cap.",
  kind: "write",
  capability: "system:admin",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { output: await pruneDiagnosticEventsAsAdmin(ctx.db, ctx.actor) };
  },
});

export const DIAGNOSTICS_ADMIN_TOOLS = [
  getDiagnosticsSettingsTool,
  setDiagnosticsSettingsTool,
  getRetentionSettingsTool,
  setRetentionSettingsTool,
  listDiagnosticEventsTool,
  getDiagnosticEventTool,
  listDocumentChangeSummariesTool,
  pruneDiagnosticEventsTool,
];
