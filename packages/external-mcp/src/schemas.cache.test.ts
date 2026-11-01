import type Ajv from "ajv";
import { expect, it, vi } from "vitest";

const compiled = vi.hoisted(() => ({ count: 0 }));
vi.mock("ajv", async (importOriginal) => {
  const actual: { default: typeof Ajv } = await importOriginal();
  class CountingAjv extends actual.default {
    constructor(...args: ConstructorParameters<typeof Ajv>) {
      super(...args);
      compiled.count += 1;
    }
  }
  return { ...actual, default: CountingAjv };
});
const { parseToolDefinitions } = await import("./schemas");

it("keeps a full catalog's validators cached across repeated listings", () => {
  const catalog = Array.from({ length: 400 }, (_, i) => ({
    name: `tool_${i}`,
    inputSchema: {
      type: "object",
      properties: { [`field_${i}`]: { type: "string" } },
    },
  }));
  parseToolDefinitions(catalog);
  const afterFirstListing = compiled.count;
  parseToolDefinitions(catalog);
  expect(afterFirstListing).toBeGreaterThanOrEqual(400);
  expect(compiled.count).toBe(afterFirstListing);
}, 30_000);
