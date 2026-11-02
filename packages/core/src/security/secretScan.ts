/** A secret-shaped finding: what it looks like and where, never its value. */
export type SecretHit = { kind: string; location: string };

const MAX_HITS = 50;
// Long lines and bounded quantifiers keep every pattern linear on hostile input.
const MAX_LINE_CHARS = 8_192;

type Rule = {
  kind: string;
  pattern: RegExp;
  accept?: (match: RegExpExecArray) => boolean;
};

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return true;
  if (/^[<{[(%$].*/.test(trimmed)) return true;
  if (/^(?:true|false|null|none|undefined)$/i.test(trimmed)) return true;
  if (/^(?:x+|\*+|\.+|-+)$/i.test(trimmed)) return true;
  return /^(?:changeme|your[-_ ]|example|placeholder)/i.test(trimmed);
}

function ibanChecksumValid(raw: string): boolean {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits)
      remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
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

const RULES: Rule[] = [
  {
    kind: "pem_private_key",
    pattern: /-----BEGIN (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "aws_secret_key",
    pattern:
      /\baws_?secret_?(?:access_?)?key["'\s]{0,3}[:=]["'\s]{0,3}[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
  },
  {
    kind: "gcp_service_account",
    pattern: /"type"\s{0,4}:\s{0,4}"service_account"/g,
  },
  { kind: "gcp_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  {
    kind: "azure_storage_key",
    pattern: /\bAccountKey=[A-Za-z0-9+/]{40,120}={0,2}/g,
  },
  {
    kind: "azure_storage_key",
    pattern: /\bSharedAccessSignature=[^\s;]{20,}/g,
  },
  {
    kind: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}(?![A-Za-z0-9])/g,
  },
  { kind: "github_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}/g },
  {
    kind: "gitlab_token",
    pattern: /\bgl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20,}/g,
  },
  { kind: "slack_token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{20,}/g },
  {
    kind: "slack_webhook",
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]{1,20}\/B[A-Za-z0-9]{1,20}\/[A-Za-z0-9]{10,}/g,
  },
  {
    kind: "stripe_key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  { kind: "stripe_key", pattern: /\bwhsec_[A-Za-z0-9]{24,}/g },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "url_credentials",
    pattern:
      /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,128}:([^\s/@]{1,256})@[^\s/]{1,256}/gi,
    accept: (match) => !isPlaceholder(`${match[1]}xxxxxxxx`),
  },
  {
    kind: "credential_assignment",
    pattern:
      /(?<![A-Za-z0-9])(?:[a-z0-9]{1,24}[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey)["']?[ \t]{0,4}[:=][ \t]{0,4}(?:"([^"\n]{1,256})"|'([^'\n]{1,256})'|([^\s"',;]{1,256}))/gi,
    accept: (match) => !isPlaceholder(match[1] ?? match[2] ?? match[3] ?? ""),
  },
  {
    kind: "iban",
    pattern:
      /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?\b/g,
    accept: (match) => ibanChecksumValid(match[0]),
  },
  {
    kind: "card_number",
    pattern: /(?<![\d-])\d{4}(?:[ -]?\d{4}){2}[ -]?\d{1,7}(?![\d-])/g,
    accept: (match) => luhnValid(match[0]),
  },
];

function scanLine(line: string, where: string, hits: SecretHit[]): void {
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (seen.has(rule.kind)) continue;
    rule.pattern.lastIndex = 0;
    for (
      let match = rule.pattern.exec(line);
      match;
      match = rule.pattern.exec(line)
    ) {
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
      if (rule.accept && !rule.accept(match)) continue;
      seen.add(rule.kind);
      if (hits.length < MAX_HITS)
        hits.push({ kind: rule.kind, location: where });
      break;
    }
  }
}

/** Finds secret-shaped text; hits name the kind and location, never the value. */
export function scanForSecrets(text: string, where: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let line = 1;
  let start = 0;
  while (start <= text.length && hits.length < MAX_HITS) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    // Overlap keeps a secret that straddles a slice boundary inside one slice.
    for (
      let offset = start;
      offset < stop || offset === start;
      offset += MAX_LINE_CHARS - 512
    ) {
      scanLine(
        text.slice(offset, Math.min(stop, offset + MAX_LINE_CHARS)),
        `${where}, line ${line}`,
        hits,
      );
      if (offset + MAX_LINE_CHARS >= stop) break;
    }
    if (end === -1) break;
    start = end + 1;
    line += 1;
  }
  return dedupe(hits);
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

/** Scans column names and every cell, naming the position rather than the content. */
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
      add(
        cell,
        `table row ${rowIndex + 1}, column ${columnLabel(columns[columnIndex], columnIndex)}`,
      ),
    ),
  );
  return dedupe(hits).slice(0, MAX_HITS);
}

// A column name that itself hit the scanner must not be echoed into a location.
function columnLabel(name: string | undefined, index: number): string {
  if (!name || scanForSecrets(name, "").length > 0) return String(index + 1);
  return name.slice(0, 60);
}
