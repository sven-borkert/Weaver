import { describe, expect, it, vi } from "vitest";
import {
  statusForCoreError,
  parseMultipartUpload,
  UploadProblem,
} from "./multipartUpload";

describe("upload HTTP errors", () => {
  it.each([
    ["INTERNAL_SERVER_ERROR", 500],
    ["CONFLICT", 409],
    ["PRECONDITION_FAILED", 412],
    ["BAD_REQUEST", 400],
  ])("maps %s to %i", (code, status) => {
    expect(statusForCoreError(code)).toBe(status);
  });
});

it("settles authorization before returning a malformed-body failure", async () => {
  let finish!: () => void;
  const authorize = vi.fn(
    () =>
      new Promise<{ projectId: string }>((resolve) => {
        finish = () => resolve({ projectId: "project" });
      }),
  );
  const body = new FormData();
  body.append("projectId", "project");
  body.append("unexpected", "value");
  let settled = false;
  const result = parseMultipartUpload(
    new Request("http://localhost/upload", { method: "POST", body }),
    {
      authorize,
      dataDir: "/unused",
      maxFiles: 1,
      maxFileBytes: 100,
      minFreeBytes: 0,
    },
  )
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prematurelySettled = settled;
  finish();
  expect(await result).toBeInstanceOf(UploadProblem);
  expect(prematurelySettled).toBe(false);
});
