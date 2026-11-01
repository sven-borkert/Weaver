import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@weaver/db/client";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "./settings";

type Row = Prisma.DiagnosticEventCreateManyInput;

function fakeDb() {
  const createMany = vi.fn(async (args: { data: Row[] }) => ({
    count: args.data.length,
  }));
  const db = {
    diagnosticEvent: { createMany },
    systemSetting: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  } as unknown as PrismaClient;
  return { db, createMany };
}

// Next.js bundles instrumentation and route handlers as separate module copies.
async function loadCopy() {
  vi.resetModules();
  return {
    writer: await import("./writer"),
    settings: await import("@weaver/core/services/diagnosticsSettings"),
    context: await import("./context"),
  };
}

afterEach(async () => {
  const { writer, settings } = await loadCopy();
  await writer.stopDiagnosticWriter();
  settings.invalidateDiagnosticsSettingsCache();
});

describe("diagnostics process state", () => {
  it("lets a separately loaded copy emit through the writer another copy started", async () => {
    const { db, createMany } = fakeDb();
    const starter = await loadCopy();
    starter.settings.primeDiagnosticsSettingsCache({
      ...DEFAULT_DIAGNOSTICS_SETTINGS,
      level: "standard",
    });
    starter.writer.startDiagnosticWriter({
      db,
      runtime: "web",
      flushIntervalMs: 60_000,
    });

    const handler = await loadCopy();
    expect(handler.writer).not.toBe(starter.writer);
    expect(
      handler.writer.emitDiagnostic({
        event: "trpc.error",
        severity: "error",
        message: "route handler failure",
      }),
    ).not.toBeNull();
    await handler.writer.flushDiagnostics();
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({
      runtime: "web",
      event: "trpc.error",
    });
  });

  it("shares the active diagnostic context across copies", async () => {
    const first = await loadCopy();
    const second = await loadCopy();
    await first.context.withDiagnosticContext(
      { requestId: "request-1" },
      async () => {
        await Promise.resolve();
        expect(second.context.currentDiagnosticContext()).toMatchObject({
          requestId: "request-1",
        });
      },
    );
  });
});
