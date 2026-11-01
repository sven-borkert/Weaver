import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getOidcProvider, parseServerEnv } from "./server";

const base = {
  DATABASE_URL: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
  AUTH_SECRET: "x".repeat(32),
  WEAVER_DATA_DIR: "./data",
};

const workspaceRoot = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
);

describe("parseServerEnv", () => {
  it("enables OIDC only with a complete server-side configuration", () => {
    expect(getOidcProvider(parseServerEnv(base))).toBeUndefined();
    const oidc = {
      WEAVER_OIDC_DISCOVERY_URL:
        "https://auth.example/application/o/weaver/.well-known/openid-configuration",
      WEAVER_OIDC_CLIENT_ID: "weaver",
      WEAVER_OIDC_CLIENT_SECRET: "test-client-secret",
      WEAVER_OIDC_DISPLAY_NAME: "Authentik",
    };
    expect(getOidcProvider(parseServerEnv({ ...base, ...oidc }))).toEqual({
      discoveryUrl: oidc.WEAVER_OIDC_DISCOVERY_URL,
      clientId: "weaver",
      clientSecret: "test-client-secret",
      displayName: "Authentik",
    });
    for (const key of [
      "WEAVER_OIDC_DISCOVERY_URL",
      "WEAVER_OIDC_CLIENT_ID",
      "WEAVER_OIDC_CLIENT_SECRET",
    ]) {
      expect(() => parseServerEnv({ ...base, ...oidc, [key]: "" })).toThrow(
        /OIDC/,
      );
    }
  });

  it("rejects unsafe OIDC discovery URLs and permits loopback development", () => {
    const oidc = {
      WEAVER_OIDC_CLIENT_ID: "weaver",
      WEAVER_OIDC_CLIENT_SECRET: "secret",
    };
    for (const url of [
      "http://auth.example/discovery",
      "https://user:secret@auth.example/discovery",
      "https://auth.example/discovery#fragment",
      "file:///discovery",
    ]) {
      expect(() =>
        parseServerEnv({ ...base, ...oidc, WEAVER_OIDC_DISCOVERY_URL: url }),
      ).toThrow();
    }
    expect(
      getOidcProvider(
        parseServerEnv({
          ...base,
          ...oidc,
          WEAVER_OIDC_DISCOVERY_URL: "http://127.0.0.1:4012/discovery",
        }),
      )?.displayName,
    ).toBe("OpenID Connect");
  });
  it("bounds the separate project API operation lock pool", () => {
    expect(
      parseServerEnv(base).WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX,
    ).toBe(2);
    expect(
      parseServerEnv({
        ...base,
        WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX: "1",
      }).WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX,
    ).toBe(1);
    for (const value of ["0", "129", "1.5"])
      expect(() =>
        parseServerEnv({
          ...base,
          WEAVER_PROJECT_API_OPERATION_LOCK_POOL_MAX: value,
        }),
      ).toThrow();
  });
  it("rejects the shipped public secret placeholder", () => {
    expect(() =>
      parseServerEnv({
        ...base,
        AUTH_SECRET: "run-openssl-rand-base64-32-and-paste-here",
      }),
    ).toThrow();
  });
  it("applies bounded Git-lock defaults", () => {
    const env = parseServerEnv(base);
    expect(env.WEAVER_GIT_LOCK_TIMEOUT_MS).toBe(10_000);
    expect(env.WEAVER_GIT_LOCK_POOL_MAX).toBe(4);
  });

  it("defaults the ingestion bounds", () => {
    const env = parseServerEnv(base);
    expect(env.WEAVER_INGESTION_MAX_FILE_BYTES).toBe(52_428_800);
    expect(env.WEAVER_ARTIFACT_MAX_FILE_BYTES).toBe(536_870_912);
    expect(env.WEAVER_INGESTION_TMP_TTL_MINUTES).toBe(60);
    expect(env.WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE).toBe(60);
  });

  it("bounds the Files cap at the OneNote reader's 512 MiB source limit", () => {
    expect(
      parseServerEnv({ ...base, WEAVER_ARTIFACT_MAX_FILE_BYTES: "536870912" })
        .WEAVER_ARTIFACT_MAX_FILE_BYTES,
    ).toBe(536_870_912);
    expect(() =>
      parseServerEnv({ ...base, WEAVER_ARTIFACT_MAX_FILE_BYTES: "536870913" }),
    ).toThrow();
  });

  it("accepts configured ingestion bounds", () => {
    const env = parseServerEnv({
      ...base,
      WEAVER_INGESTION_MAX_FILE_BYTES: "1048576",
      WEAVER_INGESTION_TMP_TTL_MINUTES: "5",
      WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE: "5",
    });
    expect(env.WEAVER_INGESTION_MAX_FILE_BYTES).toBe(1_048_576);
    expect(env.WEAVER_INGESTION_TMP_TTL_MINUTES).toBe(5);
    expect(env.WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE).toBe(5);
  });

  it("rejects an ingestion file cap outside its bounds", () => {
    expect(() =>
      parseServerEnv({ ...base, WEAVER_INGESTION_MAX_FILE_BYTES: "1023" }),
    ).toThrow();
    expect(
      parseServerEnv({
        ...base,
        WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE: "100000",
      }).WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE,
    ).toBe(100_000);
    expect(() =>
      parseServerEnv({
        ...base,
        WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE: "0",
      }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...base,
        WEAVER_INGESTION_EXTERNAL_RATE_LIMIT_PER_MINUTE: "100001",
      }),
    ).toThrow();
  });

  it("defaults the PDF export settings and parses the sandbox flag", () => {
    const parsed = parseServerEnv(base);
    expect(parsed.WEAVER_PDF_TIMEOUT_MS).toBe(30_000);
    expect(parsed.WEAVER_CHROMIUM_PATH).toBeUndefined();
    expect(parsed.WEAVER_CHROMIUM_NO_SANDBOX).toBe(false);
    expect(
      parseServerEnv({
        ...base,
        WEAVER_PDF_TIMEOUT_MS: "5000",
        WEAVER_CHROMIUM_PATH: "/usr/bin/chromium",
        WEAVER_CHROMIUM_NO_SANDBOX: "true",
      }),
    ).toMatchObject({
      WEAVER_PDF_TIMEOUT_MS: 5_000,
      WEAVER_CHROMIUM_PATH: "/usr/bin/chromium",
      WEAVER_CHROMIUM_NO_SANDBOX: true,
    });
    expect(() =>
      parseServerEnv({ ...base, WEAVER_PDF_TIMEOUT_MS: "4999" }),
    ).toThrow();
  });

  it("defaults and bounds the document image cap", () => {
    expect(parseServerEnv(base).WEAVER_DOCUMENT_IMAGE_MAX_BYTES).toBe(
      10_485_760,
    );
    expect(
      parseServerEnv({ ...base, WEAVER_DOCUMENT_IMAGE_MAX_BYTES: "2048" })
        .WEAVER_DOCUMENT_IMAGE_MAX_BYTES,
    ).toBe(2_048);
    expect(() =>
      parseServerEnv({ ...base, WEAVER_DOCUMENT_IMAGE_MAX_BYTES: "1023" }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...base,
        WEAVER_DOCUMENT_IMAGE_MAX_BYTES: "104857601",
      }),
    ).toThrow();
  });

  it("rejects unsafe lock settings", () => {
    expect(() =>
      parseServerEnv({ ...base, WEAVER_GIT_LOCK_TIMEOUT_MS: "0" }),
    ).toThrow();
    expect(() =>
      parseServerEnv({ ...base, WEAVER_GIT_LOCK_POOL_MAX: "100" }),
    ).toThrow();
  });

  it("treats empty-string values as unset", () => {
    const env = parseServerEnv({
      ...base,
      AUTH_URL: "",
      DATABASE_POOL_MAX: "",
      WEAVER_WORKER_HEALTH_PORT: "",
    });
    expect(env.AUTH_URL).toBeUndefined();
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.WEAVER_WORKER_HEALTH_PORT).toBe(3101);
  });

  it("accepts large statement timeouts and pool sizes", () => {
    const env = parseServerEnv({
      ...base,
      DATABASE_STATEMENT_TIMEOUT_MS: "900000",
      DATABASE_POOL_MAX: "150",
    });
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(900_000);
    expect(env.DATABASE_POOL_MAX).toBe(150);
  });

  it("validates the worker health port with a bounded default", () => {
    expect(parseServerEnv(base).WEAVER_WORKER_HEALTH_PORT).toBe(3101);
    expect(() =>
      parseServerEnv({ ...base, WEAVER_WORKER_HEALTH_PORT: "70000" }),
    ).toThrow();
  });

  it("does not let a build flag bypass runtime parsing", () => {
    expect(() => parseServerEnv({ SKIP_ENV_VALIDATION: "1" })).toThrow();
    expect(
      parseServerEnv({ ...base, SKIP_ENV_VALIDATION: "1" }).DATABASE_POOL_MAX,
    ).toBe(10);
  });
  it("requires an HTTPS public AUTH_URL in production", () => {
    for (const AUTH_URL of [
      undefined,
      "http://weaver.example",
      "https://user:password@weaver.example",
    ]) {
      expect(() =>
        parseServerEnv({ ...base, NODE_ENV: "production", AUTH_URL }),
      ).toThrow();
    }
    expect(
      parseServerEnv({
        ...base,
        NODE_ENV: "production",
        AUTH_URL: "https://weaver.example",
      }).AUTH_URL,
    ).toBe("https://weaver.example");
  });

  it("resolves a relative data dir against the workspace root", () => {
    const env = parseServerEnv(base);
    expect(env.WEAVER_DATA_DIR).toBe(path.join(workspaceRoot, "data"));
  });

  it("keeps an absolute data dir unchanged", () => {
    const env = parseServerEnv({ ...base, WEAVER_DATA_DIR: "/data" });
    expect(env.WEAVER_DATA_DIR).toBe("/data");
  });

  it("validates the MCP resource URL and keeps it verbatim", () => {
    expect(
      parseServerEnv({
        ...base,
        WEAVER_MCP_RESOURCE_URL: "https://weaver.example/api/mcp",
      }).WEAVER_MCP_RESOURCE_URL,
    ).toBe("https://weaver.example/api/mcp");
    expect(() =>
      parseServerEnv({ ...base, WEAVER_MCP_RESOURCE_URL: "not a url" }),
    ).toThrow();
  });

  it("accepts an explicit auth rate-limit override and rejects invalid values", () => {
    expect(
      parseServerEnv({ ...base, WEAVER_AUTH_RATE_LIMIT_ENABLED: "false" })
        .WEAVER_AUTH_RATE_LIMIT_ENABLED,
    ).toBe("false");
    expect(() =>
      parseServerEnv({ ...base, WEAVER_AUTH_RATE_LIMIT_ENABLED: "yes" }),
    ).toThrow();
  });

  it("validates the encryption key ring", () => {
    expect(() =>
      parseServerEnv({ ...base, WEAVER_ENCRYPTION_KEYS: "nope" }),
    ).toThrow();
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(
      parseServerEnv({ ...base, WEAVER_ENCRYPTION_KEYS: `1:${key}` })
        .WEAVER_ENCRYPTION_KEYS,
    ).toBe(`1:${key}`);
  });

  it("parses deployment-wide roles independently of one worker's assignment", () => {
    expect([
      ...parseServerEnv({
        ...base,
        WEAVER_ENABLED_WORKER_ROLES: "knowledge,ingestion",
      }).WEAVER_ENABLED_WORKER_ROLES,
    ]).toEqual(["knowledge", "ingestion"]);
    expect([...parseServerEnv(base).WEAVER_ENABLED_WORKER_ROLES]).toEqual([
      "knowledge",
      "assistant",
      "ingestion",
      "tasks",
      "git",
    ]);
  });

  it("parses worker roles and the OCR page budget", () => {
    const env = parseServerEnv(base);
    expect([...env.WEAVER_WORKER_ROLES]).toEqual([
      "knowledge",
      "assistant",
      "ingestion",
      "tasks",
      "git",
    ]);
    expect(env.WEAVER_INGESTION_MAX_OCR_PAGES).toBe(50);
    const narrowed = parseServerEnv({
      ...base,
      WEAVER_WORKER_ROLES: "ingestion",
      WEAVER_INGESTION_MAX_OCR_PAGES: "0",
    });
    expect([...narrowed.WEAVER_WORKER_ROLES]).toEqual(["ingestion"]);
    expect(narrowed.WEAVER_INGESTION_MAX_OCR_PAGES).toBe(0);
    expect(() =>
      parseServerEnv({ ...base, WEAVER_WORKER_ROLES: "worker" }),
    ).toThrow(/unknown worker role/);
    expect(() =>
      parseServerEnv({ ...base, WEAVER_INGESTION_MAX_OCR_PAGES: "501" }),
    ).toThrow();
  });
});

describe("MCP runtime variables (spec §26.2 item 16)", () => {
  const mcpBaseEnv = {
    DATABASE_URL: "postgresql://weaver:secret@127.0.0.1:5432/weaver",
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    WEAVER_DATA_DIR: "./data",
    NODE_ENV: "production",
    AUTH_URL: "https://weaver.example",
  };

  it("applies the documented defaults", () => {
    const env = parseServerEnv(mcpBaseEnv);
    expect(env.WEAVER_MCP_PORT).toBe(3200);
    expect(env.WEAVER_MCP_MAX_BODY_BYTES).toBe(1_048_576);
    expect(env.WEAVER_MCP_MAX_RESOURCE_CHARS).toBe(200_000);
    expect(env.WEAVER_MCP_TOOL_TIMEOUT_MS).toBe(30_000);
    expect(env.WEAVER_MCP_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(env.WEAVER_MCP_ANON_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(env.WEAVER_MCP_TRUST_PROXY).toBe(false);
    expect(env.WEAVER_OAUTH_ISSUER).toBeUndefined();
    expect(env.WEAVER_MCP_ALLOWED_HOSTS).toBeUndefined();
    expect(env.WEAVER_MCP_ALLOWED_ORIGINS).toBeUndefined();
  });

  it("accepts overrides and rejects out-of-range values", () => {
    const env = parseServerEnv({
      ...mcpBaseEnv,
      WEAVER_OAUTH_ISSUER: "https://host.example/knowledge/api/auth",
      WEAVER_MCP_PORT: "3300",
      WEAVER_MCP_ALLOWED_HOSTS: "mcp.example, host.example",
      WEAVER_MCP_TOOL_TIMEOUT_MS: "5000",
    });
    expect(env.WEAVER_OAUTH_ISSUER).toBe(
      "https://host.example/knowledge/api/auth",
    );
    expect(env.WEAVER_MCP_PORT).toBe(3300);
    expect(env.WEAVER_MCP_ALLOWED_HOSTS).toBe("mcp.example, host.example");
    expect(env.WEAVER_MCP_TOOL_TIMEOUT_MS).toBe(5000);
    expect(() =>
      parseServerEnv({ ...mcpBaseEnv, WEAVER_MCP_TOOL_TIMEOUT_MS: "500" }),
    ).toThrow();
    expect(() =>
      parseServerEnv({ ...mcpBaseEnv, WEAVER_OAUTH_ISSUER: "not-a-url" }),
    ).toThrow();
  });

  it("allows proxy trust only through an explicit strict boolean opt-in", () => {
    expect(
      parseServerEnv({ ...mcpBaseEnv, WEAVER_MCP_TRUST_PROXY: "true" })
        .WEAVER_MCP_TRUST_PROXY,
    ).toBe(true);
    expect(() =>
      parseServerEnv({ ...mcpBaseEnv, WEAVER_MCP_TRUST_PROXY: "yes" }),
    ).toThrow();
  });
});
