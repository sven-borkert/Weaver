import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWeaverUri, registerResources, resourceUriFor } from "./resources";

const diagnostic = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock("@weaver/core/diagnostics/writer", () => ({
  emitDiagnostic: diagnostic.emit,
}));

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  diagnostic.emit.mockClear();
});

function registeredRead(onAudit: () => Promise<boolean>) {
  const reads: Array<(uri: URL) => Promise<unknown>> = [];
  const server = {
    registerResource: vi.fn(
      (
        _name: string,
        _template: unknown,
        _options: unknown,
        read: (uri: URL) => Promise<unknown>,
      ) => reads.push(read),
    ),
  };
  registerResources(server as never, {
    db: {} as never,
    actor: {} as never,
    scope: async () => ({
      kind: "all",
      projectIds: [],
      documentId: null,
      tableId: null,
      resolvedAt: "2026-09-05T00:00:00.000Z",
      truncated: false,
    }),
    maxResourceChars: 1_000,
    onAudit,
  });
  return reads[0]!;
}

describe("weaver:// URIs (spec §26.2 item 2)", () => {
  it("round-trips the three resource kinds", () => {
    for (const ref of [
      { kind: "document" as const, projectId: P, documentId: R },
      { kind: "table" as const, projectId: P, tableId: R },
      { kind: "entity" as const, projectId: P, entityId: R },
    ]) {
      expect(parseWeaverUri(resourceUriFor(ref))).toEqual(ref);
    }
  });

  it("round-trips revision-addressed document and table URIs", () => {
    const sha = "c".repeat(40);
    for (const ref of [
      { kind: "document" as const, projectId: P, documentId: R, revision: sha },
      { kind: "table" as const, projectId: P, tableId: R, revision: sha },
    ]) {
      const uri = resourceUriFor(ref);
      expect(uri.endsWith(`/revisions/${sha}`)).toBe(true);
      expect(parseWeaverUri(uri)).toEqual(ref);
    }
    expect(
      parseWeaverUri(`weaver://projects/${P}/documents/${R}/revisions/short`),
    ).toBeNull();
    expect(
      parseWeaverUri(
        `weaver://projects/${P}/entities/${R}/revisions/${"c".repeat(40)}`,
      ),
    ).toBeNull();
  });

  it("rejects non-uuid segments, unknown kinds, and extra path", () => {
    expect(
      parseWeaverUri(`weaver://projects/${P}/documents/not-a-uuid`),
    ).toBeNull();
    expect(parseWeaverUri(`weaver://projects/${P}/folders/${R}`)).toBeNull();
    expect(
      parseWeaverUri(`weaver://projects/${P}/documents/${R}/extra`),
    ).toBeNull();
    expect(parseWeaverUri(`file:///${P}`)).toBeNull();
  });

  it("emits a resource diagnostic only when its audit callback owns the claim", async () => {
    const uri = new URL(`weaver://projects/${P}/documents/not-a-uuid`);

    await expect(registeredRead(async () => false)(uri)).rejects.toThrow();
    expect(diagnostic.emit).not.toHaveBeenCalled();

    await expect(registeredRead(async () => true)(uri)).rejects.toThrow();
    expect(diagnostic.emit).toHaveBeenCalledTimes(1);
    expect(diagnostic.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mcp.resource.read",
        outcome: "error",
        projectId: undefined,
        documentId: undefined,
        details: { kind: null, uri: null, code: "NOT_FOUND" },
      }),
    );
  });
});
