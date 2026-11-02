import { describe, expect, it } from "vitest";
import { DEFAULT_WORKER_ROLES, parseWorkerRoles } from "./workerRoles";

describe("parseWorkerRoles", () => {
  it("defaults to every role", () => {
    expect([...parseWorkerRoles(DEFAULT_WORKER_ROLES)]).toEqual([
      "knowledge",
      "assistant",
      "ingestion",
      "tasks",
      "git",
      "wiki",
    ]);
  });

  it("accepts a trimmed, case-insensitive subset", () => {
    expect([...parseWorkerRoles(" Ingestion , knowledge ")]).toEqual([
      "ingestion",
      "knowledge",
    ]);
  });

  it("rejects unknown and empty role lists", () => {
    expect(() => parseWorkerRoles("knowledge,parsing")).toThrow(
      /unknown worker role "parsing"/,
    );
    expect(() => parseWorkerRoles(" , ")).toThrow(/at least one role/);
  });
});
