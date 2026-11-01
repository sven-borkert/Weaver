import { withDiagnosticContext, bindDiagnosticContext } from "./context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";

import {
  invalidateDiagnosticsSettingsCache,
  primeDiagnosticsSettingsCache,
} from "@weaver/core/services/diagnosticsSettings";
import { diagnosticFetch, readCapped } from "./fetch";
import { DEFAULT_DIAGNOSTICS_SETTINGS } from "./settings";
import {
  emitDiagnostic,
  flushDiagnostics,
  startDiagnosticWriter,
  stopDiagnosticWriter,
} from "./writer";

function start(level: "errors" | "standard" | "verbose") {
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({
    count: args.data.length,
  }));
  startDiagnosticWriter({
    db: { diagnosticEvent: { createMany } } as unknown as PrismaClient,
    runtime: "worker",
    flushIntervalMs: 60_000,
  });
  primeDiagnosticsSettingsCache({ ...DEFAULT_DIAGNOSTICS_SETTINGS, level });
  return createMany;
}

it("does not inspect either provider body when assistant lineage is unknown", async () => {
  const createMany = start("verbose");
  const request = new Request("https://ai.test/model", {
    method: "POST",
    body: '{"text":"private historical request"}',
  });
  const response = new Response('{"text":"private historical response"}');
  const requestClone = vi.spyOn(request, "clone");
  const responseClone = vi.spyOn(response, "clone");
  const wrapped = diagnosticFetch(async () => response);
  await withDiagnosticContext(
    { runId: "10000000-0000-4000-8000-000000000001", bodyProjectIds: null },
    () => wrapped(request),
  );
  await flushDiagnostics(true);
  expect(requestClone).not.toHaveBeenCalled();
  expect(responseClone).not.toHaveBeenCalled();
  expect(JSON.stringify(await rows(createMany))).not.toContain(
    "private historical",
  );
});

async function rows(createMany: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await flushDiagnostics();
    const emitted = createMany.mock.calls.flatMap(
      (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
    );
    if (emitted.length > 0) return emitted;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return [];
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("fetch did not settle")),
          100,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  await stopDiagnosticWriter();
  invalidateDiagnosticsSettingsCache();
});

describe("diagnosticFetch", () => {
  it("records the cause code and summary of a transport failure", async () => {
    const createMany = start("errors");
    const cause = Object.assign(
      new Error("connect ECONNREFUSED 100.64.0.1:443"),
      { code: "ECONNREFUSED", syscall: "connect" },
    );
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const wrapped = diagnosticFetch(fetchImpl, {
      providerType: "openai_compatible",
    });
    await expect(
      wrapped("https://litellm.example/v1/chat/completions", {
        method: "POST",
        body: '{"model":"m"}',
      }),
    ).rejects.toThrow("fetch failed");
    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      event: "ai.request",
      severity: "error",
      outcome: "error",
      message:
        "POST /v1/chat/completions failed: transport_error (ECONNREFUSED)",
      details: {
        classification: "transport_error",
        model: "m",
        error: {
          name: "TypeError",
          message: "fetch failed",
          cause: { code: "ECONNREFUSED", syscall: "connect" },
        },
      },
    });
  });
  it("records status, path, model, sizes, and an error classification at standard, without bodies", async () => {
    const createMany = start("standard");
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":{"message":"overloaded"}}', { status: 503 }),
    );
    const wrapped = diagnosticFetch(fetchImpl, {
      connectionId: "11111111-1111-4111-8111-111111111111",
      providerType: "openai_compatible",
    });
    const response = await wrapped("https://llm.test/v1/chat/completions?x=1", {
      method: "POST",
      headers: { Authorization: "Bearer TEST_ONLY_HEADER_SECRET" },
      body: JSON.stringify({ model: "deepseek", messages: [] }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("overloaded");
    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      event: "ai.request",
      severity: "error",
      connectionId: "11111111-1111-4111-8111-111111111111",
      statusCode: 503,
      outcome: "error",
      hasRequestBody: false,
      hasResponseBody: false,
      details: {
        providerType: "openai_compatible",
        method: "POST",
        host: "llm.test",
        path: "/v1/chat/completions",
        model: "deepseek",
        requestBytes: 34,
        responseBytes: null,
        error: "http_error",
      },
    });
    expect(JSON.stringify(row)).not.toContain("TEST_ONLY_HEADER_SECRET");
  });

  it("scrubs echoed request credentials and recognizable keys from bodies and metadata", async () => {
    const createMany = start("verbose");
    const secret = 'opaque-credential-with-"quotes"';
    const marker = "sk-proj-EXAMPLE_ONLY_NOT_A_SECRET";
    const payload = JSON.stringify({
      error: { message: `Incorrect API key provided: ${secret}; ${marker}` },
    });
    const wrapped = diagnosticFetch(
      async () => new Response(payload, { status: 400 }),
    );
    const response = await wrapped("https://llm.test/v1/chat", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: secret, messages: [{ content: secret }] }),
    });
    expect(await response.text()).toBe(payload);
    const emitted = JSON.stringify(await rows(createMany));
    expect(emitted).not.toContain("opaque-credential");
    expect(emitted).not.toContain(marker);
    expect(emitted).toContain("[redacted]");
  });

  it("scrubs known credentials after JSON escape decoding", async () => {
    const createMany = start("verbose");
    const secret = "opaque-EXAMPLE-ONLY";
    const encoded = [...secret]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const wrapped = diagnosticFetch(
      async () => new Response(`{"error":{"message":"${encoded}"}}`),
    );
    await wrapped("https://llm.test/v1/chat", {
      headers: { "x-api-key": secret },
    });
    const emitted = JSON.stringify(await rows(createMany));
    expect(emitted).not.toContain(secret);
    expect(emitted).toContain("[redacted]");
  });

  it("stores capped, redacted bodies at verbose and leaves the response readable", async () => {
    const createMany = start("verbose");
    const responseText = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field${index}`,
          "y".repeat(200),
        ]),
      ),
    );
    const wrapped = diagnosticFetch(async () => new Response(responseText));
    const response = await wrapped("https://llm.test/v1/embeddings", {
      method: "POST",
      body: '{"model":"e","api_key":"TEST_ONLY_BODY_SECRET","input":["a"]}',
    });
    expect(await response.text()).toBe(responseText);
    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      severity: "info",
      outcome: "ok",
      hasRequestBody: true,
      hasResponseBody: true,
      requestBody: '{"model":"e","api_key":"[redacted]","input":["a"]}',
    });
    expect((row!.responseBody as string).length).toBe(32_768);
    expect(JSON.stringify(row)).not.toContain("TEST_ONLY_BODY_SECRET");
  });

  it("redacts header-style credentials in freeform verbose body strings", async () => {
    const createMany = start("verbose");
    const requestBody = JSON.stringify({
      model: "safe-model",
      note: "x-api-key: TEST_ONLY_REQUEST_COLON",
      alternate: "X-API-Key= TEST_ONLY_REQUEST_EQUALS",
      scheme: "Basic\ndXNlcjpwYXNz",
    });
    const responseBody = JSON.stringify({
      note: "x-api-key: TEST_ONLY_RESPONSE_COLON",
      alternate: "X-API-Key= TEST_ONLY_RESPONSE_EQUALS",
      scheme: "Basic\ndXNlcjpwYXNz",
    });
    const wrapped = diagnosticFetch(async () => new Response(responseBody));

    const response = await wrapped("https://llm.test/v1/chat/completions", {
      method: "POST",
      body: requestBody,
    });

    expect(await response.text()).toBe(responseBody);
    const [row] = await rows(createMany);
    expect(JSON.stringify(row)).not.toContain("TEST_ONLY_");
    expect(JSON.parse(row!.requestBody as string)).toEqual({
      model: "safe-model",
      note: "[redacted]",
      alternate: "[redacted]",
      scheme: "[redacted]",
    });
    expect(JSON.parse(row!.responseBody as string)).toEqual({
      note: "[redacted]",
      alternate: "[redacted]",
      scheme: "[redacted]",
    });
  });

  it("uses a Request input's method and body metadata without its query", async () => {
    const createMany = start("standard");
    const body = '{"model":"request-model","input":"x"}';
    const request = new Request("https://llm.test/v1/embeddings?debug=true", {
      method: "PATCH",
      body,
    });
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    const response = await wrapped(request);

    expect(response.status).toBe(204);
    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: {
        method: "PATCH",
        host: "llm.test",
        path: "/v1/embeddings",
        model: "request-model",
        requestBytes: 37,
      },
    });
  });

  it("uses a Uint8Array init body instead of the Request body's metadata", async () => {
    const createMany = start("standard");
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: '{"model":"old-model"}',
    });
    const body = new TextEncoder().encode('{"model":"new-model"}');
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped(request, { body });

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: {
        model: "new-model",
        requestBytes: 21,
        requestBodyComplete: true,
      },
    });
    expect(JSON.stringify(row)).not.toContain("old-model");
  });

  it("inherits a Request body when init.body is null", async () => {
    const createMany = start("standard");
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: '{"model":"inherited"}',
    });
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped(request, { body: null });

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: {
        model: "inherited",
        requestBytes: 21,
        requestBodyComplete: true,
      },
    });
  });

  it("bounds a binary init preview while retaining its known byte size", async () => {
    const createMany = start("standard");
    const body = new Uint8Array(70_000).fill(0xff);
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped("https://llm.test/v1/embeddings", { method: "POST", body });

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: {
        model: null,
        requestBytes: 70_000,
        requestBodyComplete: false,
      },
    });
  });

  it("uses raw bytes for a complete Request body even when decoding changes text", async () => {
    const createMany = start("standard");
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: new Uint8Array([0xef, 0xbb, 0xbf, 0xff]),
    });
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped(request);

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: { requestBytes: 4, requestBodyComplete: true },
    });
  });

  it("does not retain a relative target's query or fragment when URL parsing fails", async () => {
    const createMany = start("standard");
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped("/v1/models?debug=true#trace");

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: { host: "", path: "/v1/models" },
    });
    expect(JSON.stringify(row)).not.toContain("debug=true");
    expect(JSON.stringify(row)).not.toContain("trace");
  });

  it("marks a capped Request body size unknown instead of reporting its preview", async () => {
    const createMany = start("standard");
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "large", input: "x".repeat(70_000) }),
    });
    const wrapped = diagnosticFetch(
      async () => new Response(null, { status: 204 }),
    );

    await wrapped(request);

    const [row] = await rows(createMany);
    expect(row).toMatchObject({
      details: { requestBytes: null, requestBodyComplete: false },
    });
  });

  it.each([
    ["zero", "0"],
    ["invalid", "many"],
  ])(
    "does not report a %s content-length as a response size",
    async (_, value) => {
      const createMany = start("standard");
      const wrapped = diagnosticFetch(
        async () =>
          new Response("ok", { headers: { "content-length": value } }),
      );

      await wrapped("https://llm.test/v1/models");

      const [row] = await rows(createMany);
      expect(row).toMatchObject({ details: { responseBytes: null } });
    },
  );

  it("ignores response capture failures and returns the original response", async () => {
    const createMany = start("verbose");
    const original = new Response('{"ok":true}');
    Object.defineProperty(original, "clone", {
      value: () => {
        throw new Error("clone failed");
      },
    });
    const wrapped = diagnosticFetch(async () => original);

    const response = await wrapped("https://llm.test/v1/models");

    expect(response).toBe(original);
    expect(await response.text()).toBe('{"ok":true}');
    const [row] = await rows(createMany);
    expect(row).toMatchObject({ hasResponseBody: false });
  });

  it("ignores response body-read failures", async () => {
    const createMany = start("verbose");
    const original = new Response('{"ok":true}');
    Object.defineProperty(original, "clone", {
      value: () =>
        ({
          body: {
            getReader: () => {
              throw new Error("read failed");
            },
          },
        }) as unknown as Response,
    });
    const wrapped = diagnosticFetch(async () => original);

    await expect(wrapped("https://llm.test/v1/models")).resolves.toBe(original);

    const [row] = await rows(createMany);
    expect(row).toMatchObject({ hasResponseBody: false });
  });

  it.each(["off", "standard"] as const)(
    "returns the original response when ok inspection throws at %s diagnostics",
    async (level) => {
      if (level === "standard") start("standard");
      else
        primeDiagnosticsSettingsCache({
          ...DEFAULT_DIAGNOSTICS_SETTINGS,
          level: "off",
        });
      const response = new Response("provider body");
      Object.defineProperty(response, "ok", {
        get() {
          throw new Error("hostile ok");
        },
      });
      const wrapped = diagnosticFetch(async () => response);

      await expect(wrapped("https://llm.test/v1/models")).resolves.toBe(
        response,
      );
    },
  );

  it("returns promptly while a cloned Request body remains stalled", async () => {
    const createMany = start("standard");
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        return undefined;
      },
    });
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: stalled,
      duplex: "half",
    } as RequestInit);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const wrapped = diagnosticFetch(fetchImpl);

    await expect(within(wrapped(request))).resolves.toMatchObject({
      status: 204,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await rows(createMany);
  });

  it("rethows an already-aborted Request promptly while its body is stalled", async () => {
    start("standard");
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    controller.abort(abortError);
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start() {
          return undefined;
        },
      }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const wrapped = diagnosticFetch(async () => {
      throw abortError;
    });

    await expect(within(wrapped(request))).rejects.toBe(abortError);
  });

  it("returns a verbose response promptly when its cloned body caps then stalls", async () => {
    start("verbose");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(70_000));
        },
      }),
    );
    const wrapped = diagnosticFetch(async () => response);

    await expect(within(wrapped("https://llm.test/v1/models"))).resolves.toBe(
      response,
    );
  });

  it("clones a verbose response before a stalled Request capture can delay it", async () => {
    const createMany = start("verbose");
    const request = new Request("https://llm.test/v1/embeddings", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start() {
          return undefined;
        },
      }),
      duplex: "half",
    } as RequestInit);
    const wrapped = diagnosticFetch(
      async () => new Response('{"answer":"captured"}'),
    );

    const response = await wrapped(request);
    expect(await response.text()).toBe('{"answer":"captured"}');

    const [row] = await rows(createMany);
    expect(row).toMatchObject({ responseBody: '{"answer":"captured"}' });
  });

  it("drains a completed call's pending capture before diagnostic shutdown", async () => {
    const createMany = start("standard");
    const wrapped = diagnosticFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              return undefined;
            },
          }),
          { status: 500 },
        ),
    );

    await wrapped("https://llm.test/v1/models");
    await stopDiagnosticWriter();

    expect(
      createMany.mock.calls.flatMap(
        (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
      ),
    ).toMatchObject([{ event: "ai.request", outcome: "error" }]);
  });

  it("redacts nested and escaped structured standard error data", async () => {
    const createMany = start("standard");
    const wrapped = diagnosticFetch(
      async () =>
        new Response(
          '{"error":{"message":"TEST_ONLY_MESSAGE","content":"TEST_ONLY_CONTENT"},"api\\u005fkey":"TEST_ONLY_ESCAPED_SECRET"}',
          { status: 500 },
        ),
    );

    await wrapped("https://llm.test/v1/models");

    const [row] = await rows(createMany);
    expect(JSON.stringify(row)).not.toContain("TEST_ONLY_");
    expect((row!.details as { error: unknown }).error).toBe("http_error");
  });

  it("classifies malformed and plain standard errors without retaining their text", async () => {
    const createMany = start("standard");
    const malformed = diagnosticFetch(
      async () =>
        new Response('{"error":{"message":"TEST_ONLY_LEAK"', { status: 500 }),
    );
    await malformed("https://llm.test/v1/models");
    const [malformedRow] = await rows(createMany);
    expect((malformedRow!.details as { error: unknown }).error).toBe(
      "http_error",
    );

    await stopDiagnosticWriter();
    const safeCreateMany = start("standard");
    const safe = diagnosticFetch(
      async () => new Response("upstream overloaded", { status: 500 }),
    );
    await safe("https://llm.test/v1/models");
    const [safeRow] = await rows(safeCreateMany);
    expect((safeRow!.details as { error: unknown }).error).toBe("http_error");
  });

  it("classifies aborts and network failures and rethrows", async () => {
    const createMany = start("standard");
    const aborted = new DOMException("aborted", "AbortError");
    const wrapped = diagnosticFetch(async () => {
      throw aborted;
    });
    await expect(wrapped("https://llm.test/v1/models")).rejects.toBe(aborted);
    const networkError = new TypeError("fetch failed");
    const failing = diagnosticFetch(async () => {
      throw networkError;
    });
    await expect(failing("https://llm.test/v1/models")).rejects.toBe(
      networkError,
    );
    const list = await rows(createMany);
    expect(list.map((row) => row.outcome)).toEqual(["cancelled", "error"]);
  });

  it("readCapped stops at the cap", async () => {
    const text = await readCapped(new Response("abcdefghij"), 4);
    expect(text).toBe("abcd");
  });

  it("readCapped decodes UTF-8 split across stream chunks before capping", async () => {
    const bytes = new TextEncoder().encode("€abc");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1, 2));
          controller.enqueue(bytes.slice(2));
          controller.close();
        },
      }),
    );

    await expect(readCapped(response, 2)).resolves.toBe("€a");
  });

  it("readCapped does not skip a split code point when a UTF-16 cap cuts it", async () => {
    const bytes = new TextEncoder().encode("😀a");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 2));
          controller.enqueue(bytes.slice(2, 4));
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      }),
    );

    await expect(readCapped(response, 1)).resolves.toBe("");
  });
});

it("captures delayed SSE responses without delaying the provider response", async () => {
  const createMany = start("verbose");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"delayed answer"}}],"usage":{"completion_tokens":12}}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        }, 60);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const wrapped = diagnosticFetch(async () => response);
  expect(await within(wrapped("https://llm.test/v1/chat/completions"))).toBe(
    response,
  );
  expect(await response.text()).toContain("delayed answer");
  const [row] = await rows(createMany);
  expect(row?.responseBody).toContain("delayed answer");
  expect(row?.responseBody).toContain('"completion_tokens":12');
});

it("does not clone request bodies when diagnostics are off", async () => {
  primeDiagnosticsSettingsCache({
    ...DEFAULT_DIAGNOSTICS_SETTINGS,
    level: "off",
  });
  const request = new Request("https://llm.test/v1/chat/completions", {
    method: "POST",
    body: '{"model":"m"}',
  });
  const clone = vi.spyOn(request, "clone");
  const response = new Response("ok");
  expect(await diagnosticFetch(async () => response)(request)).toBe(response);
  expect(clone).not.toHaveBeenCalled();
});

it("caps string request capture before parsing and reports its complete byte size", async () => {
  const createMany = start("verbose");
  const body = JSON.stringify({ model: "m", input: "x".repeat(100_000) });
  await diagnosticFetch(async () => new Response("{}"))(
    "https://llm.test/v1/embeddings",
    { method: "POST", body },
  );
  const [row] = await rows(createMany);
  expect(row).toMatchObject({
    details: {
      requestBytes: Buffer.byteLength(body),
      requestBodyComplete: false,
    },
  });
});

it("captures a bounded partial SSE response at its deadline", async () => {
  const createMany = start("verbose");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"text":"partial"}\n\n'),
        );
      },
    }),
  );
  await diagnosticFetch(async () => response, { requestTimeoutMs: 30 })(
    "https://llm.test/v1/chat/completions",
  );
  const [row] = await rows(createMany);
  expect(row).toMatchObject({ details: { responseBodyComplete: false } });
  expect(row?.responseBody).toContain("partial");
  await response.body?.cancel();
});

it("cancels stalled verbose capture promptly at writer shutdown", async () => {
  const createMany = start("verbose");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"text":"before shutdown"}\n\n'),
        );
      },
    }),
  );
  await diagnosticFetch(async () => response)(
    "https://llm.test/v1/chat/completions",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await within(stopDiagnosticWriter());
  const emitted = createMany.mock.calls.flatMap(
    (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
  );
  expect(emitted[0]?.responseBody).toContain("before shutdown");
  expect(emitted[0]).toMatchObject({
    details: { responseBodyComplete: false },
  });
  await response.body?.cancel();
});

it.each(["response", "stream", "error"])(
  "suppresses external bodies and keeps independent metadata for %s after nested bound callbacks",
  async (kind) => {
    const createMany = start("verbose");
    const sentinel = "EXTERNAL_PRIVATE_SENTINEL";
    const request = new Request("https://example.test/model", {
      method: "POST",
      body: JSON.stringify({ prompt: sentinel }),
    });
    const requestClone = vi.spyOn(request, "clone");
    const original = new Response(
      kind === "stream"
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: {"text":"${sentinel}"}\n\n`),
              );
              controller.close();
            },
          })
        : JSON.stringify({ text: sentinel }),
      { headers: { "content-length": "123" } },
    );
    const responseClone = vi.spyOn(original, "clone");
    const error = new Error(sentinel);
    const wrapped = diagnosticFetch(
      async () => {
        if (kind === "error") throw error;
        return original;
      },
      {
        connectionId: "11111111-1111-4111-8111-111111111111",
        providerType: "openai_compatible",
      },
    );
    const callback = withDiagnosticContext(
      { suppressProviderBodies: true },
      () =>
        withDiagnosticContext({ suppressProviderBodies: false }, () =>
          bindDiagnosticContext(async () => {
            emitDiagnostic({
              event: "assistant.attempt.succeeded",
              message: "attempt completed",
              details: { inputTokens: 17, outputTokens: 9 },
            });
            return wrapped(request);
          }),
        ),
    );
    if (kind === "error") await expect(callback()).rejects.toBe(error);
    else expect(await (await callback()).text()).toContain(sentinel);
    await stopDiagnosticWriter();
    const persisted = await rows(createMany);
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
    expect(requestClone).not.toHaveBeenCalled();
    expect(responseClone).not.toHaveBeenCalled();
    const requestEvent = persisted.find((row) => row.event === "ai.request");
    expect(requestEvent).toMatchObject({
      connectionId: "11111111-1111-4111-8111-111111111111",
      hasRequestBody: false,
      hasResponseBody: false,
      details: { method: "POST", path: "/model" },
    });
    expect(typeof requestEvent?.durationMs).toBe("number");
    expect(
      persisted.find((row) => row.event === "assistant.attempt.succeeded"),
    ).toMatchObject({ details: { inputTokens: 17, outputTokens: 9 } });
  },
);
