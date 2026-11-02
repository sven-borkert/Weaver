import { createHash } from "node:crypto";
import { diffLines } from "diff";

export const GUIDE_MAX_BYTES = 16_000;

export type GuideRemoval = { kind: string; count: number };
export type GuideLineFlag = { line: number; text: string; reason: string };
export type GuideDiffLine = { type: "same" | "add" | "del"; text: string };

const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/gu;

/** Default-ignorable and bidi control characters removed, nothing else changed. */
export function stripIgnorable(text: string): string {
  return text.replace(IGNORABLE, "");
}

function removalKind(codePoint: number): string {
  if (codePoint === 0x00ad) return "soft hyphen";
  if (codePoint >= 0x200b && codePoint <= 0x200d) return "zero-width character";
  if (codePoint === 0x2060 || codePoint === 0xfeff)
    return "zero-width character";
  if (
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
    return "bidirectional control";
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x180b && codePoint <= 0x180d) ||
    codePoint === 0x180f
  )
    return "variation selector";
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "tag character";
  return "other invisible character";
}

/** NFC, then removal of every default-ignorable and bidi-control character; the digest covers exactly the returned text. */
export function normalizeGuideText(body: string): {
  text: string;
  removed: GuideRemoval[];
  digest: string;
} {
  const counts = new Map<string, number>();
  const stripped = body.normalize("NFC").replace(IGNORABLE, (match) => {
    const kind = removalKind(match.codePointAt(0)!);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return "";
  });
  const text = stripped.normalize("NFC");
  return {
    text,
    removed: [...counts].map(([kind, count]) => ({ kind, count })),
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function guideByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const DELEGATION: { pattern: RegExp; reason: string }[] = [
  { pattern: /https?:\/\//i, reason: "Mentions an external address" },
  { pattern: /weaver:\/\//i, reason: "Links to other content" },
  {
    pattern:
      /\b(?:follow|obey|apply|use|read)\b[^.\n]{0,60}\b(?:rules?|instructions?|guidelines?|policy|policies)\b[^.\n]{0,40}\b(?:in|at|from|of)\b/i,
    reason: "Takes its rules from somewhere else",
  },
  {
    pattern:
      /\b(?:see|refer to|consult|fetch|load|download)\b[^.\n]{0,60}\b(?:page|document|file|url|link|site|website|repo|repository)\b/i,
    reason: "Points to another place for its rules",
  },
  {
    pattern:
      /\b(?:ignore|disregard|override|forget)\b[^.\n]{0,40}\b(?:above|previous|prior|earlier|system|other)\b/i,
    reason: "Tries to override other instructions",
  },
  {
    pattern:
      /\b(?:call|invoke|run|execute)\b[^.\n]{0,30}\b(?:tool|function|command)s?\b/i,
    reason: "Asks for tool calls",
  },
];

/** Advisory only: lines that hand authority to text outside the approved guide. */
export function guideAdvisoryFlags(text: string): GuideLineFlag[] {
  const flags: GuideLineFlag[] = [];
  text.split("\n").forEach((line, index) => {
    const hit = DELEGATION.find((rule) => rule.pattern.test(line));
    if (hit)
      flags.push({
        line: index + 1,
        text: line.slice(0, 300),
        reason: hit.reason,
      });
  });
  return flags;
}

/** Line diff of the previously approved text against the text now under review. */
export function guideDiff(
  previous: string | null,
  current: string,
): GuideDiffLine[] {
  if (previous === null) return [];
  const lines: GuideDiffLine[] = [];
  for (const part of diffLines(previous, current, { maxEditLength: 5000 }) ??
    []) {
    const type = part.added ? "add" : part.removed ? "del" : "same";
    const rows = part.value.split("\n");
    if (rows.at(-1) === "") rows.pop();
    for (const text of rows) lines.push({ type, text });
  }
  return lines;
}
