import { expect, it, vi } from "vitest";
import type { EncryptionKeyRing } from "@weaver/core/security/encryption";

// externalMcp.ts is server-only; vitest runs it outside RSC bundling.
vi.mock("server-only", () => ({}));

const { createExternalMcpTransport } = vi.hoisted(() => ({
  createExternalMcpTransport: vi.fn(() => ({}) as never),
}));
vi.mock("@weaver/external-mcp", () => ({ createExternalMcpTransport }));

import { externalMcpRuntime } from "./externalMcp";

// Regression test: a pre-guarded fetchImpl double-wraps and silently drops insecureTls.
it("gives the transport the plain global fetch", () => {
  externalMcpRuntime({
    db: {} as never,
    encryptionKeys: {} as EncryptionKeyRing,
  });

  expect(createExternalMcpTransport).toHaveBeenCalledWith({ fetchImpl: fetch });
});
