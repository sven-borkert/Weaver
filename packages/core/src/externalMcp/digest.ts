import { createHash } from "node:crypto";
import type { ExternalInvocation, JsonValue } from "./types";
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}
export function canonicalDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function invocationIdentity(
  invocation: ExternalInvocation,
  runWide: boolean,
): JsonValue {
  return {
    owner:
      runWide && invocation.owner.kind === "assistant"
        ? { kind: "assistant", runId: invocation.owner.runId }
        : invocation.owner,
    toolId: invocation.toolId,
    toolDigest: invocation.expectedToolDigest,
    configRevision: invocation.expectedConfigRevision,
    arguments: invocation.arguments,
    scope: {
      ...invocation.scope,
      projectIds: [...new Set(invocation.scope.projectIds)].sort(),
    },
  };
}
export function externalInvocationDigest(
  invocation: ExternalInvocation,
): string {
  return canonicalDigest(invocationIdentity(invocation, false));
}
export function externalDenialDigest(invocation: ExternalInvocation): string {
  return canonicalDigest(invocationIdentity(invocation, true));
}
