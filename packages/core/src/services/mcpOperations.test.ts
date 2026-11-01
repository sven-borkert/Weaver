import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { recordMcpAudit, type McpAuditInput } from "./mcpOperations";

const event: McpAuditInput = {
  requestId: "request-1",
  userId: "11111111-1111-4111-8111-111111111111",
  credentialId: "credential-1",
  authenticationMethod: "apiKey",
  clientId: null,
  method: "tools/call",
  name: "read_document",
  projectId: "22222222-2222-4222-8222-222222222222",
  outcome: "error",
  errorCode: "NOT_FOUND",
  durationMs: 1,
  commitSha: null,
};

function relationError(field: string): Error {
  return Object.assign(new Error("foreign key violation"), {
    code: "P2003",
    meta: {
      driverAdapterError: { cause: { constraint: { fields: [field] } } },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordMcpAudit", () => {
  it("retries a missing-project foreign key failure without project attachment", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(relationError("projectId"))
      .mockResolvedValueOnce({});
    const db = { mcpAuditEvent: { create } } as unknown as PrismaClient;

    await recordMcpAudit(db, event);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, { data: event });
    expect(create).toHaveBeenNthCalledWith(2, {
      data: { ...event, projectId: null },
    });
  });

  it("does not retry an unrelated relation failure", async () => {
    const error = relationError("userId");
    const create = vi.fn().mockRejectedValue(error);
    const db = { mcpAuditEvent: { create } } as unknown as PrismaClient;
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await recordMcpAudit(db, event);

    expect(create).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
  });

  it("keeps a failed fallback non-fatal and reports the retry error", async () => {
    const retryError = new Error("database unavailable");
    retryError.name = "RetryDatabaseError";
    const create = vi
      .fn()
      .mockRejectedValueOnce(relationError("projectId"))
      .mockRejectedValueOnce(retryError);
    const db = { mcpAuditEvent: { create } } as unknown as PrismaClient;
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(recordMcpAudit(db, event)).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      "mcp audit insert failed for request request-1 (ref none)",
    );
  });
});
