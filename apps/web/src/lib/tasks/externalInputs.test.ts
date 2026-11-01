import { describe, expect, it } from "vitest";
import {
  buildLiteralInput,
  eligibleTaskTools,
  readExternalInputSummaries,
} from "./externalInputs";

describe("external task inputs", () => {
  it("wraps top-level JSON values without executing strings", () => {
    expect(
      buildLiteralInput("Daily counts", "tool-id", '{"hours":24}'),
    ).toEqual({
      name: "Daily counts",
      toolId: "tool-id",
      arguments: { hours: { kind: "literal", value: 24 } },
    });
    expect(
      buildLiteralInput(
        "Text",
        "tool-id",
        '{"code":"process.exit()","nested":[null,true]}',
      ).arguments,
    ).toEqual({
      code: { kind: "literal", value: "process.exit()" },
      nested: { kind: "literal", value: [null, true] },
    });
  });
  it.each(["[]", "null", "42", "{bad}"])(
    "pins invalid JSON/object %s before mutation",
    (text) => {
      expect(() => buildLiteralInput("Bad", "tool-id", text)).toThrow();
      try {
        buildLiteralInput("Bad", "tool-id", text);
      } catch (error) {
        expect(error).toHaveProperty("field", "externalInputs");
      }
    },
  );
  it("intersects automatic read tools across source and output", () => {
    const read = {
      id: "read",
      connectionId: "c",
      name: "Read",
      description: "",
      effect: "read" as const,
      inputSchema: {},
      configRevision: 1,
      reviewDigest: "digest",
    };
    expect(
      eligibleTaskTools(
        [read, { ...read, id: "write", effect: "write" }],
        [read],
      ),
    ).toEqual([read]);
    expect(eligibleTaskTools([read], [])).toEqual([]);
  });
  it("accepts only safe summary metadata from legacy unknown contexts", () => {
    expect(readExternalInputSummaries(null)).toEqual([]);
    expect(
      readExternalInputSummaries({ externalInputs: [null, { name: "bad" }] }),
    ).toEqual([]);
    expect(
      readExternalInputSummaries({
        externalInputs: [
          {
            name: "Counts",
            status: "failed",
            retrievedAt: null,
            truncated: false,
            errorCode: "SECRET",
            output: "SECRET",
            arguments: { token: "SECRET" },
          },
        ],
      }),
    ).toEqual([
      {
        name: "Counts",
        status: "failed",
        retrievedAt: null,
        truncated: false,
        failure: "External input failed.",
      },
    ]);
  });
});

it.each(["__proto__", "constructor", "toString"])(
  "uses safe fallback for prototype code %s",
  (errorCode) => {
    expect(
      readExternalInputSummaries({
        externalInputs: [
          {
            name: "Input",
            status: "failed",
            retrievedAt: null,
            truncated: false,
            errorCode,
          },
        ],
      })[0]?.failure,
    ).toBe("External input failed.");
  },
);
