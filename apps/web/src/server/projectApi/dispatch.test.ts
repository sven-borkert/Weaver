import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@weaver/core/errors";
import { projectApiRoute } from "@weaver/core/projectApi/contracts";

vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("~/env", () => ({ env: { WEAVER_AUTH_TRUST_PROXY: true } }));
vi.mock("@weaver/core/security/projectMachine", () => ({
  resolveProjectMachineContext: vi.fn(),
}));
vi.mock("@weaver/core/projectApi/rateLimit", () => ({
  admitProjectMachineRequest: vi.fn(),
}));
vi.mock("@weaver/core/projectApi/audit", () => ({
  recordProjectApiAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@weaver/core/projectApi/queries", () => ({
  queryProjectMachineContent: vi.fn(async () => ({
    items: [],
    nextCursor: null,
  })),
}));
vi.mock("@weaver/core/services/projectApi", () => ({
  publishProjectMachineContent: vi.fn(),
}));
vi.mock("@weaver/core/diagnostics/writer", () => ({
  emitDiagnostic: vi.fn(),
  captureError: vi.fn(),
}));

import { resolveProjectMachineContext } from "@weaver/core/security/projectMachine";
import { handleProjectApiRequest } from "./dispatch";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("machine API admission", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects rotating unknown credentials before authentication and leaves other sources available", async () => {
    vi.mocked(resolveProjectMachineContext).mockRejectedValue(
      new CoreError("UNAUTHORIZED"),
    );
    const route = projectApiRoute("documents");
    const request = (i: number, address = "192.0.2.40") =>
      new Request(`http://localhost/api/v1/projects/${projectId}/documents`, {
        headers: { authorization: `Bearer fake-${i}`, "x-real-ip": address },
      });
    let limited: Response | undefined;
    for (let i = 0; i < 500; i++) {
      const response = await handleProjectApiRequest(
        request(i),
        { projectId },
        route,
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toMatch(/^\d+$/);
    const calls = vi.mocked(resolveProjectMachineContext).mock.calls.length;
    expect(
      (await handleProjectApiRequest(request(501), { projectId }, route))
        .status,
    ).toBe(429);
    expect(resolveProjectMachineContext).toHaveBeenCalledTimes(calls);
    expect(
      (
        await handleProjectApiRequest(
          request(502, "192.0.2.41"),
          { projectId },
          route,
        )
      ).status,
    ).toBe(401);
  });
});
