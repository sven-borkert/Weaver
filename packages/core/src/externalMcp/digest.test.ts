import { expect, it } from "vitest";
import {
  canonicalDigest,
  canonicalJson,
  externalInvocationDigest,
  externalDenialDigest,
} from "./digest";
import type { ExternalInvocation } from "./types";
const invocation: ExternalInvocation = {
  owner: {
    kind: "assistant",
    runId: "run",
    attemptId: "attempt",
    toolCallId: "call",
  },
  scope: {
    kind: "projects",
    projectIds: ["b", "a", "a"],
    documentId: null,
    tableId: null,
    resolvedAt: "2026-09-09T00:00:00Z",
    truncated: false,
  },
  toolId: "tool",
  expectedConfigRevision: 1,
  expectedToolDigest: "digest",
  arguments: { nested: { b: 2, a: 1 } },
  deadline: new Date(),
};
it("sorts object keys recursively and preserves array order", () => {
  expect(canonicalDigest({ b: { d: 1, c: 2 }, a: 1 })).toBe(
    canonicalDigest({ a: 1, b: { c: 2, d: 1 } }),
  );
  expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
});
it("binds exact invocation identity, configuration, arguments and scope", () => {
  expect(externalInvocationDigest(invocation)).toBe(
    externalInvocationDigest({
      ...invocation,
      scope: { ...invocation.scope, projectIds: ["a", "b"] },
      arguments: { nested: { a: 1, b: 2 } },
    }),
  );
  for (const changed of [
    { toolId: "other" },
    { scope: { ...invocation.scope, resolvedAt: "other" } },
    { expectedConfigRevision: 2 },
    { expectedToolDigest: "other" },
    { arguments: { x: 1 } },
    { scope: { ...invocation.scope, projectIds: ["a"] } },
    { owner: { ...invocation.owner, toolCallId: "another" } },
  ])
    expect(
      externalInvocationDigest({
        ...invocation,
        ...changed,
      }),
    ).not.toBe(externalInvocationDigest(invocation));
});
it("deduplicates denials throughout the run without allowing cross-run reuse", () => {
  const owner = {
    kind: "assistant" as const,
    runId: "run",
    attemptId: "next",
    toolCallId: "next",
  };
  const next: ExternalInvocation = { ...invocation, owner };
  expect(externalDenialDigest(next)).toBe(externalDenialDigest(invocation));
  expect(
    externalDenialDigest({ ...next, owner: { ...owner, runId: "other" } }),
  ).not.toBe(externalDenialDigest(invocation));
});

it("canonicalizes nested object keys without changing array order", () => {
  expect(canonicalDigest({ b: [1, { z: true, a: null }], a: "a" })).toBe(
    canonicalDigest({ a: "a", b: [1, { a: null, z: true }] }),
  );
  expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
  expect(canonicalJson({ text: '"\\\n', number: -0 })).toBe(
    '{"number":0,"text":"\\"\\\\\\n"}',
  );
});
