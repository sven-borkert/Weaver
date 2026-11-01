import { expect, it } from "vitest";
import { parseToolDefinitions, validateArguments } from "./schemas";
const tool = (inputSchema: unknown) => ({ name: "test", inputSchema });
it("preserves definitions and enforces local references without coercion", () => {
  const schema = {
    type: "object",
    $defs: { number: { type: "integer", minimum: 0 } },
    properties: { count: { $ref: "#/$defs/number" } },
    required: ["count"],
    additionalProperties: false,
  };
  const [definition] = parseToolDefinitions([tool(schema)]);
  expect(definition?.inputSchema).toEqual(schema);
  expect(() => validateArguments(definition!, { count: 1 })).not.toThrow();
  expect(() => validateArguments(definition!, { count: "1" })).toThrow(
    "INVALID_ARGUMENTS",
  );
});
it.each([true, { type: "array" }, { type: "object", properties: "bad" }])(
  "rejects malformed root schemas atomically",
  (schema) => {
    expect(() =>
      parseToolDefinitions([
        tool({ type: "object" }),
        { name: "other", inputSchema: schema },
      ]),
    ).toThrow("INVALID_CATALOG");
  },
);
it("keeps unsupported schemas discoverable but never executable", () => {
  for (const schema of [
    {
      type: "object",
      properties: { x: { $ref: "https://other.test/schema" } },
    },
    { type: "object", unknownAssertion: true },
  ]) {
    const [definition] = parseToolDefinitions([tool(schema)]);
    expect(definition?.supportStatus).toEqual({
      available: false,
      reason: "UNSUPPORTED_SCHEMA",
    });
    expect(() => validateArguments(definition!, {})).toThrow(
      "UNSUPPORTED_SCHEMA",
    );
  }
});
it("rejects duplicate names, oversized definitions and excessive depth", () => {
  expect(() =>
    parseToolDefinitions([tool({ type: "object" }), tool({ type: "object" })]),
  ).toThrow("INVALID_CATALOG");
  expect(() =>
    parseToolDefinitions([
      { ...tool({ type: "object" }), description: "x".repeat(65536) },
    ]),
  ).toThrow("INVALID_CATALOG");
  let schema: object = { type: "string" };
  for (let i = 0; i < 40; i++)
    schema = { type: "object", properties: { nested: schema } };
  expect(() => parseToolDefinitions([tool(schema)])).toThrow("INVALID_CATALOG");
});
it("rejects non-JSON and oversized arguments before dispatch", () => {
  const [definition] = parseToolDefinitions([tool({ type: "object" })]);
  expect(() => validateArguments(definition!, { x: Infinity })).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() =>
    validateArguments(definition!, { x: "x".repeat(16384) }),
  ).toThrow("INVALID_ARGUMENTS");
});
it("validates supported date-time and date formats", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: {
        start: { type: "string", format: "date-time" },
        day: { type: "string", format: "date" },
      },
      required: ["start", "day"],
    }),
  ]);
  expect(definition?.supportStatus.available).toBe(true);
  expect(() =>
    validateArguments(definition!, {
      start: "2026-09-09T00:00:00Z",
      day: "2026-09-09",
    }),
  ).not.toThrow();
  expect(() =>
    validateArguments(definition!, { start: "tomorrow", day: "2026-09-09" }),
  ).toThrow("INVALID_ARGUMENTS");
});
it("validates supported uuid, email and uri formats", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        contact: { type: "string", format: "email" },
        page: { type: "string", format: "uri" },
      },
      required: ["id", "contact", "page"],
    }),
  ]);
  expect(definition?.supportStatus.available).toBe(true);
  expect(() =>
    validateArguments(definition!, {
      id: "123e4567-e89b-12d3-a456-426614174000",
      contact: "user@example.com",
      page: "https://example.com/path",
    }),
  ).not.toThrow();
  expect(() =>
    validateArguments(definition!, {
      id: "not-a-uuid",
      contact: "user@example.com",
      page: "https://example.com/path",
    }),
  ).toThrow("INVALID_ARGUMENTS");
});
it("marks tools with an unregistered format as unsupported", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { host: { type: "string", format: "hostname" } },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({
    available: false,
    reason: "UNSUPPORTED_SCHEMA",
  });
});
it("does not mistake const data for schema keywords", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: {
        literal: { const: { pattern: "data", $ref: "also data" } },
      },
    }),
  ]);
  expect(definition?.supportStatus.available).toBe(true);
});
it("rejects malformed schemas even with an unsupported dialect", () => {
  expect(() =>
    parseToolDefinitions([
      tool({
        type: "object",
        $schema: "https://unknown.test/dialect",
        properties: "invalid",
      }),
    ]),
  ).toThrow("INVALID_CATALOG");
});

it("validates catastrophic-backtracking patterns in linear time", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { trigger: { type: "boolean" }, value: { type: "string" } },
      dependencies: {
        trigger: {
          properties: { value: { type: "string", pattern: "^(a+)+$" } },
        },
      },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  const started = Date.now();
  expect(() =>
    validateArguments(definition!, {
      trigger: true,
      value: "a".repeat(5000) + "!",
    }),
  ).toThrow("INVALID_ARGUMENTS");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(() =>
    validateArguments(definition!, { trigger: true, value: "aaa" }),
  ).not.toThrow();
});
it("validates patterns and patternProperties", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { id: { type: "string", pattern: "^APP-\\d{3,}$" } },
      patternProperties: { "^x-": { type: "integer" } },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  expect(() =>
    validateArguments(definition!, { id: "APP-123", "x-n": 1 }),
  ).not.toThrow();
  expect(() => validateArguments(definition!, { id: "APP-12" })).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() => validateArguments(definition!, { "x-n": "1" })).toThrow(
    "INVALID_ARGUMENTS",
  );
});
it("keeps patterns that need backtracking features unavailable", () => {
  expect(
    parseToolDefinitions([
      tool({
        type: "object",
        properties: { x: { type: "string", pattern: "^(a)\\1$" } },
      }),
    ])[0]?.supportStatus,
  ).toEqual({ available: false, reason: "UNSUPPORTED_SCHEMA" });
});
it("accepts union types", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { cell: { type: ["string", "number", "null"] } },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  expect(() => validateArguments(definition!, { cell: 1 })).not.toThrow();
  expect(() => validateArguments(definition!, { cell: true })).toThrow(
    "INVALID_ARGUMENTS",
  );
});
it("preserves and validates draft-07 property-name dependencies", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { trigger: { type: "boolean" }, value: { type: "string" } },
      dependencies: { trigger: ["value"] },
    }),
  ]);
  expect(definition?.supportStatus.available).toBe(true);
  expect(() => validateArguments(definition!, { trigger: true })).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() =>
    validateArguments(definition!, { trigger: true, value: "present" }),
  ).not.toThrow();
});

it("bounds discovered descriptions and removes control characters", () => {
  const [definition] = parseToolDefinitions([
    {
      name: "safe",
      description: "\u0000\u001b" + "x".repeat(5000),
      inputSchema: { type: "object" },
    },
  ]);
  expect(definition?.description?.length).toBeLessThanOrEqual(2000);
  expect(definition?.description).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

// Support status only: never validate against a schema that is expected to be rejected.
const unavailable = { available: false, reason: "UNSUPPORTED_SCHEMA" };
const status = (schema: unknown) =>
  parseToolDefinitions([tool(schema)])[0]?.supportStatus;
it("rejects reference chains whose expansion doubles per level", () => {
  const $defs: Record<string, unknown> = { d20: { type: "string" } };
  for (let i = 0; i < 20; i++)
    $defs[`d${i}`] = {
      allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }],
    };
  expect(
    status({
      type: "object",
      properties: { x: { $ref: "#/$defs/d0" } },
      $defs,
    }),
  ).toEqual(unavailable);
});
it("rejects cycles that never descend into the instance", () => {
  expect(
    status({
      type: "object",
      properties: { x: { $ref: "#/$defs/a" } },
      $defs: {
        a: { anyOf: [{ $ref: "#/$defs/b" }, { type: "null" }] },
        b: { allOf: [{ $ref: "#/$defs/a" }] },
      },
    }),
  ).toEqual(unavailable);
  expect(
    status({ type: "object", dependencies: { x: { $ref: "#" } } }),
  ).toEqual(unavailable);
});
it("resolves JSON-pointer references anywhere in the root schema", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: {
        a: { type: "string", maxLength: 3 },
        b: { $ref: "#/properties/a" },
        c: { anyOf: [{ type: "integer" }, { type: "null" }] },
        d: { $ref: "#/properties/c/anyOf/0" },
      },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  expect(() =>
    validateArguments(definition!, { b: "abc", d: 1 }),
  ).not.toThrow();
  expect(() => validateArguments(definition!, { b: "abcd" })).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() => validateArguments(definition!, { d: "1" })).toThrow(
    "INVALID_ARGUMENTS",
  );
});
it("rejects missing and self-referencing pointer targets", () => {
  expect(
    status({ type: "object", properties: { b: { $ref: "#/properties/a" } } }),
  ).toEqual(unavailable);
  expect(
    status({ type: "object", properties: { a: { $ref: "#/properties/a" } } }),
  ).toEqual(unavailable);
  expect(
    status({
      type: "object",
      properties: { a: { $ref: "#/properties/__proto__" } },
    }),
  ).toEqual(unavailable);
});
it("keeps reused nullable definitions available", () => {
  const nullable = { anyOf: [{ $ref: "#/$defs/T" }, { type: "null" }] };
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { first: nullable, second: nullable, third: nullable },
      $defs: {
        T: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
        },
      },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  expect(() =>
    validateArguments(definition!, { first: { id: 1 }, second: null }),
  ).not.toThrow();
  expect(() => validateArguments(definition!, { first: {} })).toThrow(
    "INVALID_ARGUMENTS",
  );
  expect(() =>
    validateArguments(definition!, { first: { id: 2 } }),
  ).not.toThrow();
});
it("keeps single-recursion trees available", () => {
  const [definition] = parseToolDefinitions([
    tool({
      type: "object",
      properties: { root: { $ref: "#/$defs/node" } },
      $defs: {
        node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
          required: ["name"],
        },
      },
    }),
  ]);
  expect(definition?.supportStatus).toEqual({ available: true });
  expect(() =>
    validateArguments(definition!, {
      root: { name: "a", children: [{ name: "b", children: [{}] }] },
    }),
  ).toThrow("INVALID_ARGUMENTS");
});
it("rejects definitions that recurse into their cycle more than once", () => {
  const branch = { type: "array", items: { $ref: "#/$defs/filter" } };
  expect(
    status({
      type: "object",
      properties: { filter: { $ref: "#/$defs/filter" } },
      $defs: {
        filter: { type: "object", properties: { and: branch, or: branch } },
      },
    }),
  ).toEqual(unavailable);
  expect(
    status({
      type: "object",
      properties: { a: { $ref: "#/$defs/a" } },
      $defs: {
        a: {
          type: "object",
          properties: { x: { $ref: "#/$defs/b" }, y: { $ref: "#/$defs/b" } },
        },
        b: { type: "object", properties: { back: { $ref: "#/$defs/a" } } },
      },
    }),
  ).toEqual(unavailable);
});
it("supports uniqueItems only for scalar item types", () => {
  const list = (items: unknown) => ({
    type: "object",
    properties: { list: { type: "array", uniqueItems: true, items } },
  });
  expect(status(list({ type: "string" }))).toEqual({ available: true });
  expect(status(list({ type: "object" }))).toEqual(unavailable);
  expect(
    status({ type: "object", properties: { list: { uniqueItems: true } } }),
  ).toEqual(unavailable);
  expect(
    status({
      type: "object",
      properties: { uniqueItems: { type: "boolean" } },
    }),
  ).toEqual({ available: true });
});
it("inspects pointer targets in data locations like any other subschema", () => {
  expect(
    status({
      type: "object",
      properties: {
        a: { $ref: "#/properties/b/default" },
        b: {
          type: "string",
          default: {
            type: "array",
            uniqueItems: true,
            items: { type: "object" },
          },
        },
      },
    }),
  ).toEqual(unavailable);
  for (const hidden of [
    { $id: "x" },
    { $async: true },
    { $dynamicRef: "#x" },
    { $recursiveRef: "#" },
  ])
    expect(
      status({
        type: "object",
        properties: {
          a: { $ref: "#/properties/b/default" },
          b: { type: "string", default: hidden },
        },
      }),
    ).toEqual(unavailable);
  expect(
    status({
      type: "object",
      properties: {
        a: { $ref: "#/properties/b/examples/0" },
        b: { type: "string", examples: [{ $ref: "#/properties/a" }] },
      },
    }),
  ).toEqual(unavailable);
  expect(
    status({
      type: "object",
      properties: {
        a: { type: "integer", minimum: 0 },
        b: { $ref: "#/properties/a" },
      },
    }),
  ).toEqual({ available: true });
});
