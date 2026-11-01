import { describe, expect, it } from "vitest";

import { parseJsonSubmission } from "./jsonSubmission";

const options = {
  authorize: async (projectId: string) => ({ projectId }),
  maxFileBytes: 1,
  dataDir: "/unused",
};

describe("parseJsonSubmission", () => {
  it("maps an interrupted request body to a client error", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://localhost", {
      method: "POST",
      signal: controller.signal,
      body: "{}",
    });

    await expect(parseJsonSubmission(request, options)).rejects.toMatchObject({
      status: 400,
      message: "malformed or interrupted JSON body",
    });
  });

  it("stops reading a body that exceeds its explicit request cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5_000));
      },
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Node's Request requires this for a streaming upload.
      duplex: "half",
    } as RequestInit);

    await expect(parseJsonSubmission(request, options)).rejects.toMatchObject({
      status: 413,
      message: "JSON request is too large",
    });
    expect(cancelled).toBe(true);
  });

  it("maps an abort during a pending read to a client error", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      signal: controller.signal,
      body,
      duplex: "half",
    } as RequestInit);
    const parsed = parseJsonSubmission(request, options);
    controller.abort();

    await expect(parsed).rejects.toMatchObject({
      status: 400,
      message: "malformed or interrupted JSON body",
    });
    expect(cancelled).toBe(true);
  });
});
