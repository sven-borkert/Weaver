import { describe, expect, it } from "vitest";
import { RemoteHttpError, remoteJson } from "./http";

const respond = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
) =>
  (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as typeof fetch;

describe("remoteJson", () => {
  it("parses a JSON body", async () => {
    expect(
      await remoteJson(
        respond(200, '{"ok":true}'),
        "https://b.example/api/health",
        {},
      ),
    ).toEqual({ ok: true });
  });
  it("throws RemoteHttpError with the status and body on non-2xx, including redirects", async () => {
    for (const status of [302, 401, 403, 413, 500]) {
      const error = await remoteJson(
        respond(status, '{"error":"nope"}'),
        "https://b.example/x",
        {},
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteHttpError);
      expect((error as RemoteHttpError).status).toBe(status);
      expect((error as RemoteHttpError).bodyText).toContain("nope");
    }
  });
  it("refuses a body above the cap", async () => {
    await expect(
      remoteJson(
        respond(200, JSON.stringify({ big: "x".repeat(2_000) })),
        "https://b.example/x",
        { maxBytes: 100 },
      ),
    ).rejects.toThrow(/too large/);
  });
  it("stops reading a header-less body once it passes the cap", async () => {
    const fetchImpl = async () => {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await expect(
      remoteJson(fetchImpl, "https://b.example/x", { maxBytes: 4_096 }),
    ).rejects.toThrow(/too large/);
  });
});
