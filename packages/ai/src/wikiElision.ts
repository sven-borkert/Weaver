import type { ModelMessage } from "ai";
import { promptByteSize } from "./prompt";

export const WIKI_PARALLEL_HEADROOM_BYTES = 16 * 1024;
export const WIKI_EXEMPT_SHARE = 0.25;
const LARGE_CALL_INPUT_BYTES = 512;
const STUB_PREFIX = "[elided ";

type ToolResultShape = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
};
type ToolCallShape = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};

function isStub(output: unknown): boolean {
  const value = (output as { value?: unknown } | null)?.value;
  return typeof value === "string" && value.startsWith(STUB_PREFIX);
}

function stubFor(part: ToolResultShape): ToolResultShape {
  const bytes = promptByteSize(part.output);
  return {
    ...part,
    output: {
      type: "text",
      value: `${STUB_PREFIX}${bytes} bytes of ${part.toolName}; call it again if you still need it]`,
    },
  };
}

function resultParts(message: ModelMessage): ToolResultShape[] {
  if (message.role !== "tool") return [];
  return (message.content as unknown[]).filter(
    (part): part is ToolResultShape =>
      (part as { type?: string }).type === "tool-result",
  );
}

function callParts(message: ModelMessage): ToolCallShape[] {
  if (message.role !== "assistant" || typeof message.content === "string")
    return [];
  return (message.content as unknown[]).filter(
    (part): part is ToolCallShape =>
      (part as { type?: string }).type === "tool-call",
  );
}

/**
 * Oldest tool results become one-line stubs until the array fits maxInputBytes minus the
 * headroom. Past the floor of what can be dropped the caller's fit check decides.
 */
export function elideMessages(
  messages: readonly ModelMessage[],
  options: {
    maxInputBytes: number;
    parallelCalls: number;
    exemptIds: ReadonlySet<string>;
  },
): ModelMessage[] {
  const target =
    options.maxInputBytes -
    WIKI_PARALLEL_HEADROOM_BYTES * Math.max(1, options.parallelCalls);
  let total = promptByteSize(messages);
  const out = [...messages];
  if (total <= target) return out;
  const callIndex = new Map<string, number>();
  out.forEach((message, index) => {
    for (const call of callParts(message))
      callIndex.set(call.toolCallId, index);
  });
  for (let index = 0; index < out.length && total > target; index++) {
    const message = out[index]!;
    if (message.role !== "tool") continue;
    const content = [...(message.content as unknown[])];
    let changed = false;
    for (const [partIndex, raw] of content.entries()) {
      if (total <= target) break;
      const part = raw as ToolResultShape;
      if (
        part.type !== "tool-result" ||
        options.exemptIds.has(part.toolCallId) ||
        isStub(part.output)
      )
        continue;
      const stub = stubFor(part);
      total -= promptByteSize(part) - promptByteSize(stub);
      content[partIndex] = stub;
      changed = true;
      // A written page also sits in the call that wrote it; it goes with its result.
      const owner = callIndex.get(part.toolCallId);
      if (owner === undefined) continue;
      const assistant = out[owner]!;
      const parts = [...(assistant.content as unknown[])];
      const callAt = parts.findIndex(
        (entry) => (entry as ToolCallShape).toolCallId === part.toolCallId,
      );
      const call = parts[callAt] as ToolCallShape | undefined;
      if (call && promptByteSize(call.input) > LARGE_CALL_INPUT_BYTES) {
        const slim = { ...call, input: { elided: true } };
        total -= promptByteSize(call) - promptByteSize(slim);
        parts[callAt] = slim;
        out[owner] = { ...assistant, content: parts } as ModelMessage;
      }
    }
    if (changed) out[index] = { ...message, content } as ModelMessage;
  }
  return total > target ? dropOldestStubbedTurns(out, target, total) : out;
}

/** Stubs still add up over hundreds of steps; a fully stubbed turn holds nothing to keep. */
function dropOldestStubbedTurns(
  messages: ModelMessage[],
  target: number,
  startTotal: number,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  let total = startTotal;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const next = messages[index + 1];
    if (
      total > target &&
      message.role === "assistant" &&
      next?.role === "tool" &&
      resultParts(next).every((part) => isStub(part.output))
    ) {
      total -= promptByteSize(message) + promptByteSize(next) + 2;
      index += 1;
      continue;
    }
    out.push(message);
  }
  return out;
}

/** The current input's read_input and its latest source window, if together within the share. */
export function exemptResults(
  messages: readonly ModelMessage[],
  input: {
    currentItemId: string | null;
    sourceIds: ReadonlySet<string>;
    maxInputBytes: number;
  },
): Set<string> {
  const exempt = new Set<string>();
  if (!input.currentItemId) return exempt;
  let readInputCall: string | null = null;
  let windowCall: string | null = null;
  const inputs = new Map<string, ToolCallShape>();
  for (const message of messages)
    for (const call of callParts(message)) inputs.set(call.toolCallId, call);
  for (const call of inputs.values()) {
    const args = (call.input ?? {}) as Record<string, unknown>;
    if (call.toolName === "read_input" && args.id === input.currentItemId)
      readInputCall = call.toolCallId;
    const sourceId = args.documentId ?? args.tableId;
    if (typeof sourceId === "string" && input.sourceIds.has(sourceId))
      windowCall = call.toolCallId;
  }
  const sizes = new Map<string, number>();
  for (const message of messages)
    for (const part of resultParts(message))
      if (part.toolCallId === readInputCall || part.toolCallId === windowCall)
        sizes.set(part.toolCallId, promptByteSize(part));
  const bound = input.maxInputBytes * WIKI_EXEMPT_SHARE;
  let used = 0;
  for (const id of [readInputCall, windowCall]) {
    if (!id) continue;
    const size = sizes.get(id);
    if (size === undefined || used + size > bound) continue;
    exempt.add(id);
    used += size;
  }
  return exempt;
}
