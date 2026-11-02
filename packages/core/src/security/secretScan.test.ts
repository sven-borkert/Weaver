import { describe, expect, it } from "vitest";
import { scanForSecrets, scanTableForSecrets } from "./secretScan";

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
  ["IBAN with a bad checksum", j("DE89 3704 0044 ", "0532 0130 01")],
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

  it("bounds its hits and stays linear on hostile input", () => {
    const many = Array.from({ length: 500 }, () =>
      j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    ).join("\n");
    expect(scanForSecrets(many, "note").length).toBeLessThanOrEqual(50);
    const started = Date.now();
    scanForSecrets(`${"a".repeat(200_000)}://${"b:".repeat(50_000)}`, "note");
    scanForSecrets(`${"password ".repeat(20_000)}`, "note");
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 10_000);
});

describe("scanTableForSecrets", () => {
  it("scans every cell and column name, naming the position", () => {
    const hits = scanTableForSecrets(
      ["name", "value"],
      [
        ["a", "b"],
        ["c", j("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")],
      ],
    );
    expect(hits).toEqual([
      { kind: "github_token", location: "table row 2, column value" },
    ]);
  });

  it("scans a column name", () => {
    const hits = scanTableForSecrets([j("AKIA", "IOSFODNN7EXAMPLE")], [["x"]]);
    expect(hits[0]?.location).toBe("table column 1");
  });
});
