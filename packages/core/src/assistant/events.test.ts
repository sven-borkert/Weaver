import { describe, expect, it } from "vitest";
import {
  assistantEventSchema,
  BOUNDED_JSON_SLACK_CHARS,
  boundedJson,
  MAX_EVENT_PAYLOAD_CHARS,
  reduceRunEvents,
} from "./events";

describe("assistantEventSchema", () => {
  it("accepts each event type and rejects unknown ones", () => {
    expect(
      assistantEventSchema.parse({ type: "text.delta", text: "hi" }).type,
    ).toBe("text.delta");
    expect(
      assistantEventSchema.parse({
        type: "run.failed",
        code: "PROVIDER_UNAVAILABLE",
        message: "x",
        retrying: false,
      }).type,
    ).toBe("run.failed");
    expect(() => assistantEventSchema.parse({ type: "nope" })).toThrow();
  });
});

describe("boundedJson", () => {
  it("truncates long strings and marks truncation", () => {
    const value = boundedJson({
      text: "a".repeat(MAX_EVENT_PAYLOAD_CHARS + 10),
    });
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(
      MAX_EVENT_PAYLOAD_CHARS + 64,
    );
    expect(value).toMatchObject({ truncated: true });
  });
  it("passes small values through unchanged", () => {
    expect(boundedJson({ a: 1, b: ["x"] })).toEqual({ a: 1, b: ["x"] });
  });
  it("bounds a value whose size comes from a wide array of short strings", () => {
    const value = {
      ids: Array.from({ length: 20_000 }, (_, i) => `id-${i}`),
    };
    const bounded = boundedJson(value);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      MAX_EVENT_PAYLOAD_CHARS + BOUNDED_JSON_SLACK_CHARS,
    );
  });
  it("bounds a value whose size comes from deep/wide structure rather than one long string", () => {
    const value = {
      items: Array.from({ length: 500 }, (_, i) => ({
        id: i,
        meta: { a: i, b: i, c: i, note: `note-${i}` },
      })),
    };
    const bounded = boundedJson(value);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(
      MAX_EVENT_PAYLOAD_CHARS + BOUNDED_JSON_SLACK_CHARS,
    );
  });
});

describe("reduceRunEvents", () => {
  it("concatenates text, collects proposals, and finds the terminal state", () => {
    const reduction = reduceRunEvents([
      { type: "run.started", attempt: 1 },
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      {
        type: "proposal.created",
        proposalId: "p1",
        kind: "document.edit",
        summary: "s",
      },
      {
        type: "citation",
        citation: {
          id: "c1",
          kind: "document",
          projectId: "p",
          resourceId: "d",
          commitSha: "abc",
          label: "Doc",
          excerpt: null,
        },
      },
      { type: "run.completed", messageId: "m1" },
    ]);
    expect(reduction).toEqual({
      text: "Hello",
      terminal: "completed",
      proposalIds: ["p1"],
      citationCount: 1,
    });
  });
  it("resets text when a retry starts a new attempt", () => {
    const reduction = reduceRunEvents([
      { type: "run.started", attempt: 1 },
      { type: "text.delta", text: "partial" },
      {
        type: "run.failed",
        code: "PROVIDER_UNAVAILABLE",
        message: "503",
        retrying: true,
      },
      { type: "run.started", attempt: 2 },
      { type: "text.delta", text: "final" },
    ]);
    expect(reduction.text).toBe("final");
    expect(reduction.terminal).toBeNull();
  });
});

it("discards proposals and citations from failed attempts on retry", () => {
  const reduced = reduceRunEvents([
    { type: "run.started", attempt: 1 },
    {
      type: "proposal.created",
      proposalId: "old",
      kind: "document.edit",
      summary: "old",
    },
    {
      type: "citation",
      citation: {
        id: "c",
        kind: "document",
        projectId: "p",
        resourceId: "d",
        commitSha: "a",
        label: "old",
        excerpt: null,
      },
    },
    {
      type: "run.failed",
      code: "PROVIDER_UNAVAILABLE",
      message: "retry",
      retrying: true,
    },
    { type: "run.started", attempt: 2 },
  ]);
  expect(reduced.proposalIds).toEqual([]);
  expect(reduced.citationCount).toBe(0);
});
