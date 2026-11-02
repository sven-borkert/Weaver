/** A secret-shaped finding: what it looks like and where, never its value. */
export type SecretHit = { kind: string; location: string };

const MAX_HITS = 50;
/** The longest token matched whole: two 8 KB JWT segments plus a bounded signature. */
const MAX_SECRET_CHARS = 20_000;
export const SCAN_SLICE_CHARS = 60_000;
/** Consecutive slices share MAX_SECRET_CHARS, so no supported token straddles unseen. */
export const SCAN_STRIDE_CHARS = SCAN_SLICE_CHARS - MAX_SECRET_CHARS;

type Rule = {
  kind: string;
  pattern: RegExp;
  accept?: (match: RegExpExecArray) => boolean;
  /** On a refusal, search again from the next character instead of after the match. */
  retryInside?: boolean;
};

const PLACEHOLDER_FORMS = [
  /^\$\{[A-Za-z_][A-Za-z0-9_.:-]*\}$/,
  /^\$[A-Z_][A-Z0-9_]*$/,
  /^<[^<>]*>$/,
  /^\{\{[^{}]*\}\}$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
  /^(?:x+|\*+|\.+|-+)$/i,
  /^(?:true|false|null|none|undefined|changeme|example|placeholder|password|secret|token)$/i,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return PLACEHOLDER_FORMS.some((form) => form.test(trimmed));
}

// Registry lengths; an unknown country tries every legal length, preferring a false positive.
// prettier-ignore
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22,
  MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

function mod97(remainder: number, chars: string): number {
  let value = remainder;
  for (const char of chars) {
    const digits = char >= "A" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) value = (value * 10 + Number(digit)) % 97;
  }
  return value;
}

/** Any legal-length prefix passing the checksum counts, so trailing text cannot hide one. */
function ibanPrefixValid(raw: string): boolean {
  const compact = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const known = IBAN_LENGTHS[compact.slice(0, 2)];
  const min = known ?? 15;
  const max = Math.min(known ?? 34, compact.length);
  const head = compact.slice(0, 4);
  let remainder = 0;
  for (let length = 4; length < min; length += 1)
    remainder = mod97(remainder, compact[length] ?? "");
  for (let length = min; length <= max; length += 1) {
    if (mod97(remainder, head) === 1) return true;
    remainder = mod97(remainder, compact[length] ?? "");
  }
  return false;
}

function luhnValid(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Tries each group-aligned window of 13 to 19 digits, so neighbouring numbers cannot hide a card. */
function cardInRun(raw: string): boolean {
  const groups = raw.split(/[^0-9]+/).filter(Boolean);
  for (let start = 0; start < groups.length; start += 1) {
    let digits = "";
    for (let end = start; end < groups.length; end += 1) {
      digits += groups[end];
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhnValid(digits)) return true;
    }
  }
  return false;
}

/** userinfo runs to the last @ of the segment, so a password may itself contain @. */
function urlSegmentHasPassword(segment: string): boolean {
  const colon = segment.search(/[:/?#@]/);
  if (colon === -1 || segment[colon] !== ":") return false;
  const at = segment.lastIndexOf("@");
  if (at <= colon + 1) return false;
  return !isPlaceholder(segment.slice(colon + 1, at));
}

const KEYWORD =
  "(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|auth[_-]?key|credential)";

const BEFORE = "(?<![A-Za-z0-9])";

const RULES: Rule[] = [
  {
    kind: "pem_private_key",
    pattern: /-----BEGIN (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: "aws_access_key",
    pattern: new RegExp(`${BEFORE}(?:AKIA|ASIA)[0-9A-Z]{16}`, "g"),
  },
  {
    kind: "aws_secret_key",
    pattern:
      /aws_?secret_?(?:access_?)?key["'\\\s]{0,6}[:=]["'\\\s]{0,6}[A-Za-z0-9/+=]{40}/gi,
  },
  {
    kind: "gcp_service_account",
    pattern: /\\?"type\\?"\s{0,4}:\s{0,4}\\?"service_account\\?"/g,
  },
  {
    kind: "gcp_api_key",
    pattern: new RegExp(`${BEFORE}AIza[0-9A-Za-z_-]{35}`, "g"),
  },
  {
    kind: "azure_storage_key",
    pattern: /AccountKey=[A-Za-z0-9+/]{40}/g,
  },
  {
    kind: "azure_storage_key",
    pattern: /SharedAccessSignature=[^\s;]{20}/g,
  },
  {
    kind: "github_token",
    pattern: new RegExp(`${BEFORE}gh[pousr]_[A-Za-z0-9]{36}`, "g"),
  },
  {
    kind: "github_token",
    pattern: new RegExp(`${BEFORE}github_pat_[A-Za-z0-9_]{22}`, "g"),
  },
  {
    kind: "gitlab_token",
    pattern: new RegExp(`${BEFORE}gl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20}`, "g"),
  },
  {
    kind: "slack_token",
    pattern: new RegExp(`${BEFORE}xox[abeoprs]-[A-Za-z0-9-]{20}`, "g"),
  },
  {
    kind: "slack_webhook",
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{1,20}\/B[A-Za-z0-9]{1,20}\/[A-Za-z0-9]{10}/g,
  },
  {
    kind: "stripe_key",
    pattern: new RegExp(
      `${BEFORE}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16}`,
      "g",
    ),
  },
  {
    kind: "stripe_key",
    pattern: new RegExp(`${BEFORE}whsec_[A-Za-z0-9]{24}`, "g"),
  },
  {
    // Only a token start begins a match, so a run of "eyJ" cannot backtrack from every offset.
    kind: "jwt",
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{16}/g,
  },
  {
    // The match consumes its run, so the split below keeps this linear.
    kind: "url_credentials",
    pattern: /[a-z][a-z0-9+.-]{0,20}:\/\/(\S{1,1024})/gi,
    accept: (match) =>
      (match[1] ?? "").split("://").some(urlSegmentHasPassword),
  },
  {
    kind: "credential_assignment",
    pattern: new RegExp(
      `${KEYWORD}[A-Za-z0-9_.-]{0,32}(?:\\\\{0,3}["'])?[ \\t]{0,8}(?::=|=>|==?|:)[ \\t]{0,8}` +
        `(?:\\\\{0,3}"([^"\\\\\\n]{1,256})|\\\\{0,3}'([^'\\\\\\n]{1,256})|(?!\\\\*["'])([^\\s"',;]{1,256}))`,
      "gi",
    ),
    accept: (match) => !isPlaceholder(match[1] ?? match[2] ?? match[3] ?? ""),
  },
  {
    kind: "iban",
    pattern: /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ \t\u00a0-]?[A-Z0-9]){11,30}/gi,
    accept: (match) => ibanPrefixValid(match[0]),
    retryInside: true,
  },
  {
    kind: "card_number",
    pattern: /(?<![0-9])[0-9](?:[ \t\u00a0-]?[0-9]){12,63}/g,
    accept: (match) => cardInRun(match[0]),
  },
];

function scanSlice(slice: string, where: string, hits: SecretHit[]): void {
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (seen.has(rule.kind)) continue;
    rule.pattern.lastIndex = 0;
    for (
      let match = rule.pattern.exec(slice);
      match;
      match = rule.pattern.exec(slice)
    ) {
      if (rule.accept && !rule.accept(match)) {
        if (rule.retryInside) rule.pattern.lastIndex = match.index + 1;
        continue;
      }
      seen.add(rule.kind);
      if (hits.length < MAX_HITS)
        hits.push({ kind: rule.kind, location: where });
      break;
    }
  }
}

function dedupe(hits: SecretHit[]): SecretHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.kind}\u0000${hit.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Finds secret-shaped text; hits name the kind and location, never the value. */
export function scanForSecrets(text: string, where: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let line = 1;
  let start = 0;
  while (hits.length < MAX_HITS) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    for (let offset = start; ; offset += SCAN_STRIDE_CHARS) {
      scanSlice(
        text.slice(offset, Math.min(stop, offset + SCAN_SLICE_CHARS)),
        `${where}, line ${line}`,
        hits,
      );
      if (offset + SCAN_SLICE_CHARS >= stop) break;
    }
    if (end === -1) break;
    start = end + 1;
    line += 1;
  }
  return dedupe(hits);
}

/** Positions only: a headerless CSV makes its first data row the column names. */
export function scanTableForSecrets(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): SecretHit[] {
  const hits: SecretHit[] = [];
  const add = (text: string, where: string) => {
    if (hits.length >= MAX_HITS) return;
    for (const hit of scanForSecrets(text, where))
      hits.push({ kind: hit.kind, location: where });
  };
  columns.forEach((name, index) => add(name, `table column ${index + 1}`));
  rows.forEach((row, rowIndex) =>
    row.forEach((cell, columnIndex) =>
      add(cell, `table row ${rowIndex + 1}, column ${columnIndex + 1}`),
    ),
  );
  return dedupe(hits).slice(0, MAX_HITS);
}
