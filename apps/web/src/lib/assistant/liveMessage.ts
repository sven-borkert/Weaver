import type { CitationView } from "@weaver/core/assistant/events";
import type { RunStreamEvent } from "./runEvents";

export type ToolRow = {
  connectionId?: string;
  connectionName?: string;
  callId?: string;
  approvalId?: string;
  externalStatus?:
    | "dispatched"
    | "prepared"
    | "pending"
    | "approved"
    | "denied"
    | "completed"
    | "failed"
    | "unknown";
  toolCallId: string;
  toolName: string;
  input: unknown;
  ok: boolean | null;
  summary: string | null;
};

export type LiveMessage = {
  text: string;
  attempt: number;
  retrying: boolean;
  failure: { code: string; message: string } | null;
  tools: ToolRow[];
  citations: CitationView[];
  proposals: Array<{ proposalId: string; kind: string; summary: string }>;
  terminal: "completed" | "failed" | "cancelled" | null;
  lastSequence: number;
};

export function emptyLiveMessage(): LiveMessage {
  return {
    text: "",
    attempt: 0,
    retrying: false,
    failure: null,
    tools: [],
    citations: [],
    proposals: [],
    terminal: null,
    lastSequence: -1,
  };
}

/** Pure fold over the persisted event stream; the transcript renders its output. */
export function reduceLiveMessage(
  state: LiveMessage,
  { sequence, event }: RunStreamEvent,
): LiveMessage {
  if (sequence <= state.lastSequence) return state;
  const next: LiveMessage = { ...state, lastSequence: sequence };
  switch (event.type) {
    case "external.call.status": {
      const row: ToolRow = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        connectionId: event.connectionId,
        connectionName: event.connectionName,
        callId: event.callId,
        externalStatus: event.status,
        input: null,
        ok: ["prepared", "dispatched"].includes(event.status)
          ? null
          : event.status === "completed",
        summary: event.summary ?? event.error?.message ?? null,
      };
      return {
        ...next,
        tools: state.tools.some(
          (tool) =>
            tool.callId === event.callId ||
            tool.toolCallId === event.toolCallId,
        )
          ? state.tools.map((tool) =>
              tool.callId === event.callId ||
              tool.toolCallId === event.toolCallId
                ? { ...tool, ...row }
                : tool,
            )
          : [...state.tools, row],
      };
    }
    case "external.approval.required":
    case "external.approval.decided":
      return {
        ...next,
        tools: state.tools.map((tool) =>
          tool.callId === event.callId
            ? {
                ...tool,
                approvalId: event.approvalId,
                externalStatus:
                  event.type === "external.approval.required"
                    ? "pending"
                    : event.status,
                ok:
                  event.type === "external.approval.decided" &&
                  event.status === "denied"
                    ? false
                    : tool.ok,
              }
            : tool,
        ),
      };
    case "run.queued":
      return next;
    case "run.started":
      // A retry starts from the last complete conversation state (spec §11.1):
      // whatever the abandoned attempt streamed is discarded.
      return {
        ...next,
        text: "",
        attempt: event.attempt,
        retrying: false,
        failure: null,
        tools: [],
      };
    case "text.delta":
      return { ...next, text: state.text + event.text };
    case "tool.call":
      return {
        ...next,
        tools: [
          ...state.tools,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            ok: null,
            summary: null,
          },
        ],
      };
    case "tool.result":
      return {
        ...next,
        tools: state.tools.map((row) =>
          row.toolCallId === event.toolCallId
            ? { ...row, ok: event.ok, summary: event.summary }
            : row,
        ),
      };
    case "citation":
      return { ...next, citations: [...state.citations, event.citation] };
    case "proposal.created":
      return {
        ...next,
        proposals: [
          ...state.proposals,
          {
            proposalId: event.proposalId,
            kind: event.kind,
            summary: event.summary,
          },
        ],
      };
    case "usage":
      return next;
    case "run.completed":
      return { ...next, terminal: "completed" };
    case "run.failed":
      return {
        ...next,
        failure: { code: event.code, message: event.message },
        retrying: event.retrying,
        terminal: event.retrying ? null : "failed",
      };
    case "run.cancelled":
      return { ...next, terminal: "cancelled" };
  }
}
