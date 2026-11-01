export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;
export type RemoteToolSupportStatus =
  { available: true } | { available: false; reason: "UNSUPPORTED_SCHEMA" };
export type RemoteToolDefinition = {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  supportStatus: RemoteToolSupportStatus;
};
export type RemoteCatalog = {
  // Private admin configuration; never include this URL in diagnostics.
  canonicalEndpoint: string;
  serverInfo: JsonObject;
  protocolVersion: string;
  tools: RemoteToolDefinition[];
  resources?: JsonObject[];
};
export type RemoteToolResult = {
  isError: boolean;
  content: JsonValue[];
  structuredContent?: JsonObject;
  truncated: boolean;
  responseBytes: number;
};
export type ExternalMcpSession = {
  discover(): Promise<RemoteCatalog>;
  call(input: {
    name: string;
    arguments: JsonObject;
  }): Promise<RemoteToolResult>;
  close(): Promise<void>;
};
export type ExternalMcpTransport = {
  open(options: {
    endpoint: string;
    token: () => Promise<string | null>;
    signal: AbortSignal;
    timeoutMs?: number;
    insecureTls?: boolean;
  }): Promise<ExternalMcpSession>;
};
