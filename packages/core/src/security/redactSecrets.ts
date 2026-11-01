const REDACTED = "[redacted]";
const ALREADY_REDACTED = String.raw`\[redacted\]`;
const KEY_HEADERS =
  "x-goog-api-key|x-api-key|api[-_]?key|auth[-_]?token|access[-_]?token";
// `name` `"`? (`:`|`=`) `"`? then the opaque value up to the next delimiter.
const SEPARATOR = String.raw`("?\s*[:=]\s*"?)`;
const VALUE = String.raw`[^\s",;}\]]+`;

const REDACTIONS: Array<[RegExp, string]> = [
  // Bearer tokens wherever they appear: header echoes, curl reproductions, JSON bodies.
  [
    new RegExp(String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]+`, "gi"),
    "Bearer [redacted]",
  ],
  // `Authorization: <scheme> <token>` — an optional scheme so non-Bearer schemes lose their token too.
  [
    new RegExp(
      String.raw`\b(authorization)${SEPARATOR}(?!(?:Bearer\s+)?${ALREADY_REDACTED})(?:[A-Za-z][A-Za-z0-9-]*\s+)?${VALUE}`,
      "gi",
    ),
    `$1$2${REDACTED}`,
  ],
  [
    new RegExp(
      String.raw`\b(${KEY_HEADERS})${SEPARATOR}(?!${ALREADY_REDACTED})${VALUE}`,
      "gi",
    ),
    `$1$2${REDACTED}`,
  ],
  // Provider key formats that show up inside error bodies.
  [/\bsk-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\b(?:gsk|xai|hf)[-_][A-Za-z0-9]{8,}/g, REDACTED],
];

/** Strip anything credential-shaped before a message is persisted or streamed to a client. */
export function redactSecrets(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (!secret) continue;
    for (const value of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
    ])) {
      result = result.split(value).join(REDACTED);
    }
  }
  for (const [pattern, replacement] of REDACTIONS)
    result = result.replace(pattern, replacement);
  return result;
}
