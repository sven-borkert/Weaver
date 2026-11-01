import type { PrismaClient } from "@weaver/db/client";
import type { EncryptionKeyRing } from "../security/encryption";
import type {
  ExternalMcpTransport,
  JsonObject,
  JsonValue,
  RemoteToolDefinition,
} from "@weaver/external-mcp";
import type { ScopeSnapshot } from "../assistant/scopeSchema";

export type { JsonObject, JsonValue, RemoteToolDefinition };
export type ToolEffect = "read" | "write";
export type ExternalSelection = { connectionId: string; toolIds: string[] };
export type ExternalSource = {
  callId: string;
  connectionId: string;
  connectionName: string;
  toolName: string;
  retrievedAt: string;
  truncated: boolean;
};
export type ArgumentBinding =
  | { kind: "literal"; value: JsonValue }
  | { kind: "period_start" }
  | { kind: "period_end" };
export type ExternalArgumentBinding = ArgumentBinding;
export type ExternalInput = {
  name: string;
  toolId: string;
  arguments: Record<string, ArgumentBinding>;
};
export type ExecutionOwner =
  | { kind: "assistant"; runId: string; attemptId: string; toolCallId: string }
  | { kind: "task"; runId: string; inputId: string }
  | {
      kind: "mcp";
      requestId: string;
      credentialId: string;
      authenticationMethod: "apiKey" | "oauth";
    };
export type ExternalInvocation = {
  owner: ExecutionOwner;
  scope: ScopeSnapshot;
  toolId: string;
  expectedConfigRevision: number;
  expectedToolDigest: string;
  arguments: JsonObject;
  deadline: Date;
};
export type ExternalApprovalView = {
  id: string;
  callId: string;
  connectionName: string;
  toolName: string;
  effect: ToolEffect;
  arguments: JsonObject | null;
  expiresAt: string;
  status:
    "pending" | "approved" | "denied" | "invalidated" | "expired" | "settled";
};
export type ExternalResult = {
  summary?: string | null;
  callId: string;
  status: "completed" | "denied" | "failed" | "unknown";
  output: JsonValue | null;
  source: ExternalSource | null;
  error: { code: string; message: string } | null;
};
export type AuthorizedExternalCall = {
  connectionId: string;
  connectionName: string;
  toolId: string;
  definition: RemoteToolDefinition;
  effect: ToolEffect;
  configRevision: number;
  reviewedDigest: string;
  scopeProjectIds: string[];
};
export type AvailableExternalTool = {
  id: string;
  connectionId: string;
  name: string;
  description: string;
  effect: ToolEffect;
  inputSchema: JsonObject;
  configRevision: number;
  reviewDigest: string;
};
export type InboundExternalTool = {
  name: string;
  toolId: string;
  connectionId: string;
  connectionName: string;
  remoteName: string;
  description: string;
  effect: ToolEffect;
  inputSchema: JsonObject;
  configRevision: number;
  reviewDigest: string;
  timeoutMs: number;
};
export type ExternalRuntimeDeps = {
  db: PrismaClient;
  ring: EncryptionKeyRing;
  transport: ExternalMcpTransport;
  now: () => Date;
};

export type ExternalCallView = {
  callId: string;
  toolCallId: string;
  connectionId: string;
  connectionName: string;
  toolName: string;
  status:
    "prepared" | "dispatched" | "completed" | "denied" | "failed" | "unknown";
  summary: string | null;
  error: { code: string; message: string } | null;
};
