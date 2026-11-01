import type { ExecutionOwner, ToolEffect } from "./types";

// MCP clients confirm on their side and tasks run unattended; the assistant asks before writes unless the conversation auto-approves.
export function requiresApproval(
  ownerKind: ExecutionOwner["kind"],
  effect: ToolEffect,
  autoApprove: boolean,
): boolean {
  return ownerKind === "assistant" && effect === "write" && !autoApprove;
}
