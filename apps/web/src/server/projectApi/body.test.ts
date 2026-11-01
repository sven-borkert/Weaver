import { describe, expect, it } from "vitest";
import { assertEmptyProjectApiBody, readProjectApiJson } from "./body";
describe("bounded project API bodies", () => {
  it("counts actual streamed bytes despite Content-Length and rejects malformed UTF-8", async () => {
    const request = new Request("http://local", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
      body: '{"long":"value"}',
    });
    await expect(readProjectApiJson(request, 5)).rejects.toMatchObject({
      details: { status: 413 },
    });
    const invalid = new Request("http://local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await expect(readProjectApiJson(invalid)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("requires JSON content type", async () => {
    await expect(
      readProjectApiJson(
        new Request("http://local", { method: "POST", body: "{}" }),
      ),
    ).rejects.toMatchObject({ details: { status: 415 } });
  });
  it("accepts an empty stream on bodiless methods but refuses actual bytes", async () => {
    const emptyStream = new Request("http://local", {
      method: "DELETE",
      body: new ReadableStream({ start: (controller) => controller.close() }),
      duplex: "half",
    } as RequestInit);
    expect(emptyStream.body).not.toBeNull();
    await expect(
      assertEmptyProjectApiBody(emptyStream),
    ).resolves.toBeUndefined();
    await expect(
      assertEmptyProjectApiBody(
        new Request("http://local", {
          method: "DELETE",
          headers: { "Content-Length": "0" },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertEmptyProjectApiBody(
        new Request("http://local", { method: "DELETE", body: "{}" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      assertEmptyProjectApiBody(
        new Request("http://local", {
          method: "DELETE",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
