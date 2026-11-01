import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGESTION_SETTINGS,
  doclingEndpoint,
  ingestionSettingsPatchSchema,
  parseIngestionSettings,
} from "./settings";

describe("ingestion settings", () => {
  it("defaults to no Docling endpoint and a two-minute timeout", () => {
    expect(DEFAULT_INGESTION_SETTINGS).toEqual({
      doclingBaseUrl: null,
      doclingTimeoutMs: 120_000,
    });
    expect(parseIngestionSettings({ doclingBaseUrl: 42 })).toEqual(
      DEFAULT_INGESTION_SETTINGS,
    );
  });

  it("accepts only http(s) base URLs", () => {
    expect(
      ingestionSettingsPatchSchema.safeParse({
        doclingBaseUrl: "http://docling:5001/",
      }).success,
    ).toBe(true);
    expect(
      ingestionSettingsPatchSchema.safeParse({ doclingBaseUrl: "ftp://x" })
        .success,
    ).toBe(false);
    expect(
      ingestionSettingsPatchSchema.safeParse({ doclingTimeoutMs: 999 }).success,
    ).toBe(false);
  });

  it("joins endpoint paths regardless of a trailing slash", () => {
    expect(doclingEndpoint("http://docling:5001", "v1/convert/file")).toBe(
      "http://docling:5001/v1/convert/file",
    );
    expect(doclingEndpoint("http://docling:5001/api/", "health")).toBe(
      "http://docling:5001/api/health",
    );
  });
});

it("rejects credentials, queries and fragments in Docling URLs", () => {
  for (const doclingBaseUrl of [
    "https://u:secret@docling.local",
    "https://docling.local?key=secret",
    "https://docling.local#secret",
  ]) {
    expect(
      ingestionSettingsPatchSchema.safeParse({ doclingBaseUrl }).success,
    ).toBe(false);
  }
});
