import { describe, expect, it } from "vitest";
import {
  SCAN_SLICE_CHARS,
  SCAN_STRIDE_CHARS,
  scanForSecrets,
  scanTableForSecrets,
} from "./secretScan";

// Assembled at runtime so the corpus itself never trips a repository secret scanner.
const j = (...parts: string[]) => parts.join("");

const POSITIVES: Array<[kind: string, text: string, value: string]> = [
  [
    "pem_private_key",
    j(
      "-----BEGIN RSA PRIV",
      "ATE KEY-----\nMIIEow==\n-----END RSA PRIV",
      "ATE KEY-----",
    ),
    "MIIEow==",
  ],
  [
    "pem_private_key",
    j("-----BEGIN OPENSSH PRIV", "ATE KEY-----\nb3Blbg==\n"),
    "b3Blbg==",
  ],
  [
    "aws_access_key",
    j("key AKIA", "IOSFODNN7EXAMPLE here"),
    "IOSFODNN7EXAMPLE",
  ],
  [
    "aws_secret_key",
    j("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"),
    "bPxRfiCYEXAMPLEKEY",
  ],
  [
    "gcp_service_account",
    j('{"type": "service_', 'account", "private_key_id": "abc123def456"}'),
    "abc123def456",
  ],
  [
    "gcp_api_key",
    j("AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"),
    "SyD-9tSrke72PouQMnMX",
  ],
  [
    "azure_storage_key",
    j(
      "DefaultEndpointsProtocol=https;AccountName=foo;AccountKey=",
      "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd==",
    ),
    "abcdabcdabcdabcd",
  ],
  [
    "github_token",
    j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    "abcdefghijklmnop",
  ],
  [
    "github_token",
    j("github_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"),
    "abcdefghijkl",
  ],
  ["gitlab_token", j("glpat-", "abcdefghij1234567890"), "abcdefghij12"],
  [
    "slack_token",
    j("xoxb-", "123456789012-1234567890123-abcdefghijklmnopqrstuvwx"),
    "abcdefghijklmnop",
  ],
  [
    "slack_webhook",
    j(
      "https://hooks.slack.com/services/",
      "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    ),
    "XXXXXXXXXXXXXXXX",
  ],
  ["stripe_key", j("sk_live_", "abcdefghijklmnopqrstuvwx"), "abcdefghijklmnop"],
  ["stripe_key", j("rk_live_", "abcdefghijklmnopqrstuvwx"), "abcdefghijklmnop"],
  [
    "jwt",
    j(
      "eyJhbGciOiJIUzI1NiJ9",
      ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
    "dozjgNryP4J3jVmNHl0w5N",
  ],
  [
    "url_credentials",
    j("postgres://weaver:hunter2", "secret@db.example.com:5432/weaver"),
    "hunter2",
  ],
  [
    "url_credentials",
    j("https://user:s3cr3t-pass", "@git.example.com/repo.git"),
    "s3cr3t-pass",
  ],
  [
    "credential_assignment",
    j('password = "correct-', 'horse-battery"'),
    "correct-horse",
  ],
  [
    "credential_assignment",
    j("API_KEY: abc123", "def456ghi789"),
    "abc123def456",
  ],
  [
    "credential_assignment",
    j('"client_secret": "deadbeef', 'cafebabe"'),
    "deadbeef",
  ],
  ["iban", j("DE89 3704 0044 ", "0532 0130 00"), "0532 0130"],
  ["card_number", j("4111 1111 ", "1111 1111"), "1111 1111"],
];

const NEGATIVES: Array<[label: string, text: string]> = [
  ["plain prose about passwords", "Rotate the password every quarter."],
  ["PEM public key", "-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n"],
  ["AWS-looking short id", "AKIA123"],
  ["near miss token prefix", j("ghp_", "short")],
  ["placeholder assignment", 'password = "<your password>"'],
  ["env reference", "api_key = ${API_KEY}"],
  ["empty assignment", 'token = ""'],
  ["bare word assignment", "token: true"],
  ["url without password", "https://user@git.example.com/repo.git"],
  ["url with port only", "postgres://db.example.com:5432/weaver"],
  ["card failing Luhn", j("4111 1111 ", "1111 1112")],
  ["order number with 16 digits", "1234 5678 9012 3456"],
  ["two dot-separated words", "eyJ.notatoken"],
  ["stripe test publishable", "pk_test_abc"],
];

describe("scanForSecrets", () => {
  it.each(POSITIVES)("finds %s", (kind, text) => {
    const hits = scanForSecrets(text, "note");
    expect(hits.map((hit) => hit.kind)).toContain(kind);
  });

  it.each(NEGATIVES)("passes %s", (_label, text) => {
    expect(scanForSecrets(text, "note")).toEqual([]);
  });

  it("never returns the value", () => {
    for (const [, text, value] of POSITIVES) {
      const serialized = JSON.stringify(scanForSecrets(text, "note"));
      expect(serialized).not.toContain(value);
    }
  });

  it("reports the location with a line number and no text", () => {
    const hits = scanForSecrets(
      j("first\nsecond\ntoken = abcdef", "0123456789"),
      "note",
    );
    expect(hits).toEqual([
      { kind: "credential_assignment", location: "note, line 3" },
    ]);
  });

  it("is deterministic on a repeated call", () => {
    const text = j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789");
    expect(scanForSecrets(text, "a")).toEqual(scanForSecrets(text, "a"));
  });

  it("bounds its hits", () => {
    const many = Array.from({ length: 500 }, () =>
      j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    ).join("\n");
    expect(scanForSecrets(many, "note").length).toBeLessThanOrEqual(50);
  });

  // No clock assertion: a quadratic pattern exceeds the timeout, a slow runner does not.
  it.each([
    ["long word", "a".repeat(200_000)],
    ["word then scheme", `${"a".repeat(100_000)}://${"b:".repeat(50_000)}`],
    ["repeated scheme", "a://b:".repeat(33_333)],
    ["repeated keyword", "password".repeat(25_000)],
    ["repeated keyword with space", "password ".repeat(22_222)],
    ["repeated open quote", 'password="'.repeat(20_000)],
    ["repeated JWT start", "eyJ".repeat(66_666)],
    ["JWT without dots", `eyJ${"a".repeat(199_990)}`],
    ["repeated IBAN start", "AB12 ".repeat(40_000)],
    ["long digit run", "1".repeat(200_000)],
    ["spaced digits", "1 ".repeat(100_000)],
    ["PEM start", "-----BEGIN A ".repeat(15_000)],
  ])(
    "stays linear on 200,000 characters: %s",
    (_label, text) => {
      expect(Array.isArray(scanForSecrets(text, "note"))).toBe(true);
    },
    5_000,
  );
});

describe("placeholders match only complete forms", () => {
  it.each([
    ["dollar-brace", "password = ${DB_PASSWORD}"],
    ["dollar name", "password = $DB_PASSWORD"],
    ["angle", 'password = "<your password>"'],
    ["mustache", 'token = "{{ vault_token }}"'],
    ["percent", "api_key = %API_KEY%"],
    ["exact word", "secret: changeme"],
    ["exact word in caps", "password=PLACEHOLDER"],
    ["url password", "postgres://app:${DB_PASSWORD}@db/weaver"],
  ])("passes %s", (_label, text) => {
    expect(scanForSecrets(text, "note")).toEqual([]);
  });

  it.each([
    ["starts with $", 'password = "$ecretP4ss!"'],
    ["starts with <", "password = <h7Kq2mZp"],
    ["starts with {", "password = {h7Kq2mZp"],
    ["starts with [", "password = [h7Kq2mZp"],
    ["starts with (", "password = (h7Kq2mZp"],
    ["starts with %", "password = %h7Kq2mZp"],
    ["dollar-brace with a tail", "password = ${h7Kq}2mZp"],
    ["keyword prefix: your", "password = your-real-K3y9"],
    ["keyword prefix: example", "password = example-prod-K3y9"],
    ["keyword prefix: changeme", "password = changeme99"],
    ["short value", "password = hunter2"],
  ])("flags a real secret that %s", (_label, text) => {
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "credential_assignment",
    );
  });
});

describe("checksums do not depend on what surrounds the value", () => {
  const iban = j("DE89 3704 0044 ", "0532 0130 00");
  it.each([
    ["trailing word", `${iban} Zahlung bis Freitag`],
    ["trailing digits", `${iban} 2026`],
    ["lower case", iban.toLowerCase()],
    ["no spaces", iban.replaceAll(" ", "")],
    ["dashes", iban.replaceAll(" ", "-")],
    ["leading code-like word", `AB12 ${iban}`],
    ["two-digit-group country", j("GB82 WEST 1234 ", "5698 7654 32")],
  ])("finds an IBAN with %s", (_label, text) => {
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "iban",
    );
  });

  it("does not call a bad checksum an IBAN", () => {
    const text = j("DE89 3704 0044 ", "0532 0130 01");
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).not.toContain(
      "iban",
    );
  });

  it.each([
    ["spaces", j("4111 1111 ", "1111 1111")],
    ["dashes", j("4111-1111-", "1111-1111")],
    ["no separators", j("41111111", "11111111")],
    ["15-digit Amex", j("3782 822463 ", "10005")],
    ["a trailing year", j("4111 1111 ", "1111 1111 2028")],
    ["a leading group", j("2028 4111 1111 ", "1111 1111")],
    ["trailing text", j("4111 1111 ", "1111 1111 exp 12/28")],
  ])("finds a card with %s", (_label, text) => {
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "card_number",
    );
  });
});

describe("slicing", () => {
  const segment = (length: number) => "a".repeat(length);
  const jwt = (header: number, payload: number) =>
    j("eyJ", segment(header), ".", segment(payload), ".", segment(40));

  it.each([
    ["first slice edge", SCAN_SLICE_CHARS],
    ["second slice edge", SCAN_STRIDE_CHARS + SCAN_SLICE_CHARS],
    ["stride edge", SCAN_STRIDE_CHARS],
  ])("finds a 2 KB JWT straddling the %s", (_label, edge) => {
    const token = jwt(1_000, 1_000);
    const text = `${"x ".repeat((edge - 1_000) / 2)}${token}`;
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "jwt",
    );
  });

  it("finds an 8 KB token straddling a slice edge", () => {
    const text = `${"x ".repeat((SCAN_SLICE_CHARS - 4_000) / 2)}${jwt(4_000, 4_000)}`;
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "jwt",
    );
  });

  it("finds a token longer than the bound by its prefix", () => {
    expect(
      scanForSecrets(jwt(1_000, 8_000).concat(segment(30_000)), "note").map(
        (hit) => hit.kind,
      ),
    ).toContain("jwt");
  });
});

describe("common credential forms", () => {
  it.each([
    ["camelCase password", "dbPassword=h7Kq2mZp"],
    ["camelCase token", "authToken: h7Kq2mZp"],
    ["keyword suffix", "password_prod=h7Kq2mZp"],
    ["keyword suffix with dash", "api-key-staging: h7Kq2mZp"],
    ["shell export", "export MYSQL_PASSWORD=h7Kq2mZp"],
    ["backslash-escaped JSON", String.raw`{\"password\": \"h7Kq2mZp\"}`],
    ["backslash-escaped value", String.raw`password=\"h7Kq2mZp\"`],
    ["fat arrow", "'secret' => 'h7Kq2mZp'"],
    ["walrus", "token := h7Kq2mZp"],
    ["quoted value with spaces", 'password = "correct horse battery"'],
    ["quoted value over the bound", `password = "${"h7Kq".repeat(100)}"`],
  ])("finds %s", (_label, text) => {
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "credential_assignment",
    );
  });

  it.each([
    ["an empty user", "redis://:h7Kq2mZp@cache.example.com:6379/0"],
    ["@ in the password", "postgres://app:h7K@q2m@Zp@db.example.com/weaver"],
    ["no user and @", "redis://:h7K@q2mZp@cache.example.com"],
    [
      "a second URL in the run",
      "https://a.example/x,https://u:h7Kq2mZp@b.example",
    ],
  ])("finds URL credentials with %s", (_label, text) => {
    expect(scanForSecrets(text, "note").map((hit) => hit.kind)).toContain(
      "url_credentials",
    );
  });

  it("never returns the value of any form", () => {
    for (const text of [
      "dbPassword=h7Kq2mZp",
      "redis://:h7Kq2mZp@cache.example.com",
      String.raw`{\"password\": \"h7Kq2mZp\"}`,
    ])
      expect(JSON.stringify(scanForSecrets(text, "note"))).not.toContain(
        "h7Kq2mZp",
      );
  });
});

describe("scanTableForSecrets", () => {
  it("scans every cell, naming only the position", () => {
    const hits = scanTableForSecrets(
      ["name", "value"],
      [
        ["a", "b"],
        ["c", j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")],
      ],
    );
    expect(hits).toEqual([
      { kind: "github_token", location: "table row 2, column 2" },
    ]);
  });

  it("scans a column name and reports its position", () => {
    const hits = scanTableForSecrets([j("AKIA", "IOSFODNN7EXAMPLE")], [["x"]]);
    expect(hits[0]?.location).toBe("table column 1");
  });

  // A headerless CSV makes its first data row the column names.
  it("never echoes a column name into a location", () => {
    const hits = scanTableForSecrets(
      ["hunter2hunter2", "h7Kq2mZp"],
      [["x", j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")]],
    );
    const serialized = JSON.stringify(hits);
    expect(serialized).not.toContain("hunter2hunter2");
    expect(serialized).not.toContain("h7Kq2mZp");
    expect(hits[0]?.location).toBe("table row 1, column 2");
  });
});
