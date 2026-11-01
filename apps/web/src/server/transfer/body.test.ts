import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBoundedJson } from "./body";

const request = (body: string, contentLength?: string) =>
  new Request("http://localhost/api/transfer/documents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(contentLength ? { "content-length": contentLength } : {}),
    },
    body,
  });

describe("readBoundedJson", () => {
  it("parses a small body", async () => {
    expect(await readBoundedJson(request('{"a":1}'), 100)).toEqual({ a: 1 });
  });
  it("refuses a declared length above the cap without reading", async () => {
    await expect(
      readBoundedJson(request("{}", "1000"), 100),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("refuses a streamed body that grows past the cap", async () => {
    await expect(
      readBoundedJson(request(`{"x":"${"y".repeat(200)}"}`), 100),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it("rejects invalid JSON", async () => {
    await expect(readBoundedJson(request("{nope"), 100)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
