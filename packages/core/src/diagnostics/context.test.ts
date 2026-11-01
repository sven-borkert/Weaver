import { describe, expect, it } from "vitest";

import {
  bindDiagnosticContext,
  currentDiagnosticContext,
  withDiagnosticContext,
} from "./context";

describe("diagnostic context", () => {
  it("merges defined nested ids across awaits and restores the parent", async () => {
    expect(currentDiagnosticContext()).toEqual({});
    await withDiagnosticContext({ requestId: "r1", userId: "u1" }, async () => {
      await Promise.resolve();
      expect(currentDiagnosticContext()).toEqual({
        requestId: "r1",
        userId: "u1",
      });
      await withDiagnosticContext(
        { jobId: "j1", userId: undefined },
        async () => {
          await Promise.resolve();
          expect(currentDiagnosticContext()).toEqual({
            requestId: "r1",
            userId: "u1",
            jobId: "j1",
          });
        },
      );
      expect(currentDiagnosticContext()).toEqual({
        requestId: "r1",
        userId: "u1",
      });
    });
    expect(currentDiagnosticContext()).toEqual({});
  });

  it("isolates concurrent requests and restores context after rejection", async () => {
    await Promise.all(
      ["a", "b"].map((requestId) =>
        withDiagnosticContext({ requestId }, async () => {
          await Promise.resolve();
          expect(currentDiagnosticContext()).toEqual({ requestId });
          await expect(
            withDiagnosticContext({ jobId: "failed" }, async () => {
              await Promise.resolve();
              throw new Error("failed");
            }),
          ).rejects.toThrow("failed");
          expect(currentDiagnosticContext()).toEqual({ requestId });
        }),
      ),
    );
    expect(currentDiagnosticContext()).toEqual({});
  });
});

it("a callback captured without suppression cannot relax a suppressed caller", () => {
  const callback = bindDiagnosticContext(
    () => currentDiagnosticContext().suppressProviderBodies,
  );
  expect(
    withDiagnosticContext({ suppressProviderBodies: true }, callback),
  ).toBe(true);
});

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";

it("unions body provenance across nested scopes and bound callback callers", () => {
  const ids = [projectA];
  const callback = withDiagnosticContext({ bodyProjectIds: ids }, () => {
    ids.splice(0);
    return withDiagnosticContext({ bodyProjectIds: [projectB] }, () =>
      bindDiagnosticContext(() => currentDiagnosticContext().bodyProjectIds),
    );
  });
  expect(callback()).toEqual([projectA, projectB]);
  expect(withDiagnosticContext({ bodyProjectIds: null }, callback)).toBeNull();
  const empty = withDiagnosticContext({ bodyProjectIds: [] }, () =>
    bindDiagnosticContext(() => currentDiagnosticContext().bodyProjectIds),
  );
  expect(withDiagnosticContext({ bodyProjectIds: [projectA] }, empty)).toEqual([
    projectA,
  ]);
});

it("keeps unknown or invalid body provenance closed in nested scopes", () => {
  for (const bodyProjectIds of [null, ["invalid"]]) {
    withDiagnosticContext({ bodyProjectIds }, () => {
      withDiagnosticContext({ bodyProjectIds: [projectA] }, () => {
        expect(currentDiagnosticContext().bodyProjectIds).toBeNull();
      });
    });
  }
});
