import { describe, expect, it } from "vitest";
import {
  approvalDecisionSchema,
  connectionCreateSchema,
  connectionUpdateSchema,
  externalInputSchema,
  externalSelectionSchema,
  toolBulkReviewSchema,
} from "./schema";
import { MAX_ARGUMENT_BYTES } from "./limits";

const ids = Array.from(
  { length: 25 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
);

describe("external MCP schemas", () => {
  it("defaults connection approval to require approval and TLS verification to strict", () => {
    const parsed = connectionCreateSchema.parse({
      name: "Example",
      endpoint: "https://example.test/mcp",
      authMode: "none",
    });
    expect(parsed.allowInsecureTls).toBe(false);
  });
  it("accepts an explicit allowInsecureTls on create and update", () => {
    expect(
      connectionCreateSchema.parse({
        name: "Example",
        endpoint: "https://example.test/mcp",
        authMode: "none",
        allowInsecureTls: true,
      }).allowInsecureTls,
    ).toBe(true);
    expect(
      connectionUpdateSchema.parse({ allowInsecureTls: true }).allowInsecureTls,
    ).toBe(true);
  });
  it("rejects invalid or duplicate connection and tool IDs and selection bounds", () => {
    expect(
      externalSelectionSchema.safeParse([
        { connectionId: "not-a-uuid", toolIds: [] },
      ]).success,
    ).toBe(false);
    expect(
      externalSelectionSchema.safeParse([
        { connectionId: ids[0], toolIds: [ids[1], ids[1]] },
      ]).success,
    ).toBe(false);
    expect(
      externalSelectionSchema.safeParse([
        { connectionId: ids[0], toolIds: [ids[1]] },
        { connectionId: ids[0], toolIds: [ids[2]] },
      ]).success,
    ).toBe(false);
    expect(
      externalSelectionSchema.safeParse(
        Array.from({ length: 6 }, (_, i) => ({
          connectionId: ids[i],
          toolIds: [],
        })),
      ).success,
    ).toBe(false);
    expect(
      externalSelectionSchema.safeParse([
        { connectionId: ids[0], toolIds: ids.slice(1, 22) },
      ]).success,
    ).toBe(false);
    expect(
      externalSelectionSchema.safeParse([
        { connectionId: ids[0], toolIds: ids.slice(1, 12) },
        { connectionId: ids[12], toolIds: ids.slice(13, 23) },
      ]).success,
    ).toBe(false);
  });
  it("rejects arguments over the UTF-8 byte limit", () => {
    expect(
      externalInputSchema.safeParse([
        {
          name: "large",
          toolId: ids[0],
          arguments: {
            value: {
              kind: "literal",
              value: "😀".repeat(MAX_ARGUMENT_BYTES / 2),
            },
          },
        },
      ]).success,
    ).toBe(false);
  });
  it("rejects empty and duplicate input names", () => {
    expect(
      externalInputSchema.safeParse([
        { name: " ", toolId: ids[0], arguments: {} },
      ]).success,
    ).toBe(false);
    expect(
      externalInputSchema.safeParse([
        { name: "Same", toolId: ids[0], arguments: {} },
        { name: "same", toolId: ids[1], arguments: {} },
      ]).success,
    ).toBe(false);
  });
  it("rejects endpoint credentials and fragments", () => {
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "https://u:p@example.test/mcp",
        authMode: "none",
      }).success,
    ).toBe(false);
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "https://example.test/mcp#secret",
        authMode: "none",
      }).success,
    ).toBe(false);
  });
  it("returns validation failures for malformed create and update endpoints", () => {
    expect(() =>
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "not a URL",
        authMode: "none",
      }),
    ).not.toThrow();
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "not a URL",
        authMode: "none",
      }).success,
    ).toBe(false);
    expect(() =>
      connectionUpdateSchema.safeParse({ endpoint: "not a URL" }),
    ).not.toThrow();
    expect(
      connectionUpdateSchema.safeParse({ endpoint: "not a URL" }).success,
    ).toBe(false);
  });
  it("rejects the removed approval policy and timeout bounds", () => {
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "https://example.test",
        authMode: "none",
        approvalPolicy: "sometimes",
      }).success,
    ).toBe(false);
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "https://example.test",
        authMode: "none",
        timeoutMs: 4_999,
      }).success,
    ).toBe(false);
    expect(
      connectionUpdateSchema.safeParse({ timeoutMs: 120_001 }).success,
    ).toBe(false);
  });
  it("rejects unknown keys in every public mutation schema", () => {
    expect(
      connectionCreateSchema.safeParse({
        name: "x",
        endpoint: "https://example.test",
        authMode: "none",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      connectionUpdateSchema.safeParse({ enabled: true, extra: true }).success,
    ).toBe(false);
    expect(
      toolBulkReviewSchema.safeParse({
        connectionId: ids[0],
        items: [
          {
            toolId: ids[1],
            expectedRemoteDigest: "a".repeat(64),
            enabled: true,
            effect: "read",
            extra: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      approvalDecisionSchema.safeParse({
        approvalId: ids[0],
        decision: "approve",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
