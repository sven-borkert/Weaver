import path from "node:path";
import { describe, expect, it } from "vitest";
import { blobPath, projectFilesDir, tmpDir, tmpPath } from "./paths";

const DATA = "/srv/weaver/data";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);

describe("ingestion paths", () => {
  it("places project files beside the git tree", () => {
    expect(projectFilesDir(DATA, PROJECT)).toBe(
      path.join(DATA, "files", PROJECT),
    );
  });

  it("shards a blob by the first two digest characters", () => {
    expect(blobPath(DATA, PROJECT, DIGEST)).toBe(
      path.join(DATA, "files", PROJECT, "aa", DIGEST),
    );
  });

  it("keeps staging under the project's own tmp directory", () => {
    expect(tmpDir(DATA, PROJECT)).toBe(
      path.join(DATA, "files", PROJECT, "tmp"),
    );
    expect(tmpPath(DATA, PROJECT, UPLOAD)).toBe(
      path.join(DATA, "files", PROJECT, "tmp", UPLOAD),
    );
  });

  it("rejects a project id that is not a uuid", () => {
    expect(() => projectFilesDir(DATA, "../escape")).toThrow(/projectId/);
  });

  it("rejects a digest that is not 64 lowercase hex characters", () => {
    expect(() => blobPath(DATA, PROJECT, "../escape")).toThrow(/digest/);
    expect(() => blobPath(DATA, PROJECT, DIGEST.toUpperCase())).toThrow(
      /digest/,
    );
  });

  it("rejects an upload id that is not a uuid", () => {
    expect(() => tmpPath(DATA, PROJECT, "../escape")).toThrow(/uploadId/);
  });
});
