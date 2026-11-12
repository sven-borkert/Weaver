import type { JsonObject, JsonValue } from "./types";

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

export function boundExternalResult(
  items: readonly { type: string; text?: string }[],
  structuredContent?: JsonObject,
) {
  let remaining = 16000;
  let truncated = false;
  const content: JsonValue[] = [];
  for (const item of items) {
    if (item.type !== "text" || typeof item.text !== "string") {
      truncated = true;
      continue;
    }
    const text = utf8Prefix(item.text, remaining);
    if (text.length < item.text.length) truncated = true;
    remaining -= Buffer.byteLength(text, "utf8");
    if (text) content.push({ type: "text", text });
  }
  if (
    structuredContent !== undefined &&
    Buffer.byteLength(JSON.stringify(structuredContent), "utf8") > remaining
  ) {
    structuredContent = undefined;
    truncated = true;
  }
  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    truncated,
  };
}
