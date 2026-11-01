import { describe, expect, it } from "vitest";

import {
  errorSummary,
  MAX_BODY_CHARS,
  MAX_DETAILS_CHARS,
  sanitizeBody,
  sanitizeDetails,
  sanitizeText,
  sanitizeValue,
  truncateText,
} from "./sanitize";

describe("sanitize", () => {
  it.each([
    "Bearer abc123",
    "request failed: Bearer abc123",
    "Bearer\nTEST_ONLY_SECRET",
    "Bearer a",
    "Bearer ?",
    "request failed using Bearer\r\n\tabc123 was rejected",
  ])("redacts Bearer tokens regardless of length or whitespace: %s", (text) => {
    expect(sanitizeText(text, 500)).toBe("[redacted]");
    expect(errorSummary(new Error(text))).toBe("[redacted]");
    expect(sanitizeDetails({ diagnostic: text })).toEqual({
      diagnostic: "[redacted]",
    });
    expect(
      JSON.parse(sanitizeBody(JSON.stringify({ diagnostic: text }))!),
    ).toEqual({ diagnostic: "[redacted]" });
  });

  it.each(["messageContent", "messageText", "messageBody"])(
    "redacts private %s metadata while preserving provider content",
    (key) => {
      expect(
        sanitizeDetails({
          [key]: "TEST_ONLY_PRIVATE",
          nested: { [key]: "TEST_ONLY_PRIVATE" },
          messageId: "m1",
          messageContentType: "text/plain",
        }),
      ).toEqual({
        [key]: "[redacted]",
        nested: { [key]: "[redacted]" },
        messageId: "m1",
        messageContentType: "text/plain",
      });
      expect(
        JSON.parse(sanitizeBody(JSON.stringify({ [key]: "allowed" }))!),
      ).toEqual({ [key]: "allowed" });
    },
  );

  it.each([
    "Bearer TEST_ONLY_SECRET was rejected",
    "request failed using Bearer TEST_ONLY_SECRET",
    "request failed: Basic dXNlcjpwYXNz (401)",
    "request failed: Basic dTpw (401)",
  ])("redacts embedded credential schemes: %s", (text) => {
    expect(sanitizeText(text, 500)).toBe("[redacted]");
    expect(errorSummary(new Error(text))).toBe("[redacted]");
    expect(sanitizeDetails({ diagnostic: text })).toEqual({
      diagnostic: "[redacted]",
    });
    expect(
      JSON.parse(sanitizeBody(JSON.stringify({ diagnostic: text }))!),
    ).toEqual({ diagnostic: "[redacted]" });
  });

  it("redacts intentional role/source private prefixes while keeping metadata", () => {
    expect(
      sanitizeDetails({
        user_content: "private",
        assistantText: "private",
        rawPrompt: "private",
        system_message: "private",
        modelResponse: { content: "private" },
        chat_history: ["private"],
        rawMessages: ["private"],
        documentBody: "private",
        responseText: "private",
        context: { requestId: "r1" },
        userId: "u1",
        rawPromptCount: 3,
        contentType: "text/plain",
        assistantModel: "m1",
        errorMessage: "basic configuration unavailable",
      }),
    ).toEqual({
      user_content: "[redacted]",
      assistantText: "[redacted]",
      rawPrompt: "[redacted]",
      system_message: "[redacted]",
      modelResponse: { content: "[redacted]" },
      chat_history: "[redacted]",
      rawMessages: "[redacted]",
      documentBody: "[redacted]",
      responseText: "[redacted]",
      context: { requestId: "r1" },
      userId: "u1",
      rawPromptCount: 3,
      contentType: "text/plain",
      assistantModel: "m1",
      errorMessage: "basic configuration unavailable",
    });
    expect(sanitizeText("basic model unavailable", 500)).toBe(
      "basic model unavailable",
    );
    expect(sanitizeText("basic operation unavailable", 500)).toBe(
      "basic operation unavailable",
    );
    expect(
      JSON.parse(
        sanitizeBody(
          JSON.stringify({
            user_content: "allowed",
            assistantText: "allowed",
            rawPrompt: "allowed",
          }),
        )!,
      ),
    ).toEqual({
      user_content: "allowed",
      assistantText: "allowed",
      rawPrompt: "allowed",
    });
  });

  it.each(["api__key=TEST_ONLY_SECRET", "api  key: TEST_ONLY_SECRET"])(
    "redacts credential labels with separator runs: %s",
    (text) => {
      expect(sanitizeText(text, 500)).toBe("[redacted]");
      expect(errorSummary(new Error(text))).toBe("[redacted]");
    },
  );

  it.each([
    "x-api-key: TEST_ONLY_X_API_KEY_COLON",
    "X-API-Key= TEST_ONLY_X_API_KEY_EQUALS",
    "Basic\ndXNlcjpwYXNz",
  ])("redacts header-style credentials in freeform text: %s", (text) => {
    expect(sanitizeText(text, 500)).toBe("[redacted]");
    expect(sanitizeDetails({ diagnostic: text })).toEqual({
      diagnostic: "[redacted]",
    });
    expect(
      JSON.parse(sanitizeBody(JSON.stringify({ diagnostic: text }))!),
    ).toEqual({ diagnostic: "[redacted]" });
  });

  it.each(["inputTokens: 45", "credentialId: c1", "basic model unavailable"])(
    "preserves safe prose and identifier labels: %s",
    (text) => {
      expect(sanitizeText(text, 500)).toBe(text);
      expect(errorSummary(new Error(text))).toBe(`Error: ${text}`);
      expect(sanitizeDetails({ errorMessage: text })).toEqual({
        errorMessage: text,
      });
    },
  );

  it("redacts normalized private names without treating safe context as text", () => {
    expect(
      sanitizeDetails({
        conversation_history: [{ user: "TEST_ONLY_PRIVATE" }],
        chatHistory: ["TEST_ONLY_PRIVATE"],
        context: { requestId: "r1", count: 2 },
        contentType: "text/plain",
        model: "test-model",
        tool: "search",
        path: "/docs/test.md",
        errorMessage: "model unavailable",
      }),
    ).toEqual({
      conversation_history: "[redacted]",
      chatHistory: "[redacted]",
      context: { requestId: "r1", count: 2 },
      contentType: "text/plain",
      model: "test-model",
      tool: "search",
      path: "/docs/test.md",
      errorMessage: "model unavailable",
    });
  });

  it("normalizes credential-key separators in metadata and provider bodies", () => {
    const value = {
      "api  key": "TEST_ONLY_SECRET",
      nested: { api__key: "TEST_ONLY_SECRET" },
      inputTokens: 45,
    };
    const expected = {
      "api  key": "[redacted]",
      nested: { api__key: "[redacted]" },
      inputTokens: 45,
    };
    expect(sanitizeDetails(value)).toEqual(expected);
    expect(JSON.parse(sanitizeBody(JSON.stringify(value))!)).toEqual(expected);
    expect(
      JSON.parse(
        sanitizeBody(
          JSON.stringify({
            conversation_history: [{ user: "permitted" }],
            note: "api__key=TEST_ONLY_SECRET",
            context: { model: "test-model" },
          }),
        )!,
      ),
    ).toEqual({
      conversation_history: [{ user: "permitted" }],
      note: "[redacted]",
      context: { model: "test-model" },
    });
  });

  it.each([
    "Authorization: Bearer TEST_ONLY_SECRET",
    "authorization = Basic TEST_ONLY_SECRET",
    "Bearer TEST_ONLY_SECRET",
    "Basic TEST_ONLY_SECRET",
    "credential: TEST_ONLY_SECRET",
    'api_key="TEST_ONLY_SECRET"',
    "api-key = TEST_ONLY_SECRET",
    "api key: TEST_ONLY_SECRET",
    "apiKey: TEST_ONLY_SECRET",
    "secret='TEST_ONLY_SECRET'",
    "access_token=TEST_ONLY_SECRET",
    "password: TEST_ONLY_SECRET",
    "Cookie: session=TEST_ONLY_SECRET; other=TEST_ONLY_COOKIE",
    'request failed: {"password": "TEST_ONLY_SECRET with spaces"}',
  ])("redacts credential-bearing text: %s", (text) => {
    expect(sanitizeText(text, 500)).not.toContain("TEST_ONLY_");
    expect(errorSummary(new Error(text))).not.toContain("TEST_ONLY_");
    expect(
      JSON.stringify(
        sanitizeDetails({ error: new Error(text), diagnostic: text }),
      ),
    ).not.toContain("TEST_ONLY_");
  });

  it("redacts private structured metadata recursively while retaining safe metadata", () => {
    expect(
      sanitizeDetails({
        prompt: "private",
        system_prompt: "private",
        messages: [{ content: "private" }],
        nested: {
          conversation: "private",
          message: "private",
          content: "private",
          documentText: "private",
          document_body: "private",
          text: "private",
          requestBody: "private",
        },
        model: "model-id",
        toolName: "search_documents",
        count: 2,
        path: "/docs/guide.md",
        error: new Error("service unavailable"),
        messageId: "m1",
        contentType: "text/plain",
      }),
    ).toEqual({
      prompt: "[redacted]",
      system_prompt: "[redacted]",
      messages: "[redacted]",
      nested: {
        conversation: "[redacted]",
        message: "[redacted]",
        content: "[redacted]",
        documentText: "[redacted]",
        document_body: "[redacted]",
        text: "[redacted]",
        requestBody: "[redacted]",
      },
      model: "model-id",
      toolName: "search_documents",
      count: 2,
      path: "/docs/guide.md",
      error: "Error: service unavailable",
      messageId: "m1",
      contentType: "text/plain",
    });
    expect(sanitizeText("model model-id unavailable", 500)).toBe(
      "model model-id unavailable",
    );
    expect(sanitizeText("x".repeat(501), 500)).toHaveLength(500);
  });

  it("retains provider conversations but sanitizes credential-bearing body strings", () => {
    expect(
      JSON.parse(
        sanitizeBody(
          JSON.stringify({
            prompt: "explain this",
            messages: [{ content: "hello" }],
            nested: { note: "Authorization: Bearer TEST_ONLY_SECRET" },
          }),
        )!,
      ),
    ).toEqual({
      prompt: "explain this",
      messages: [{ content: "hello" }],
      nested: { note: "[redacted]" },
    });
  });

  it("contains hostile input at the text sanitization boundary", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("TEST_ONLY_SECRET");
        },
      },
    );
    expect(() => sanitizeText(hostile as string, 500)).not.toThrow();
    expect(sanitizeText(hostile as string, 500)).toBe("[unavailable]");
  });

  it("redacts credential-like keys at any depth", () => {
    expect(
      sanitizeValue({
        model: "m",
        Authorization: "Bearer x",
        nested: { api_key: "k", apiKey: "k", password: "p", ok: 1 },
        list: [{ token: "t" }, { secret: "s" }, { cookie: "c" }],
      }),
    ).toEqual({
      model: "m",
      Authorization: "[redacted]",
      nested: {
        api_key: "[redacted]",
        apiKey: "[redacted]",
        password: "[redacted]",
        ok: 1,
      },
      list: [
        { token: "[redacted]" },
        { secret: "[redacted]" },
        { cookie: "[redacted]" },
      ],
    });
  });

  it("does not retain global regexp state across keys", () => {
    expect(sanitizeValue({ token: "a", secret: "b", password: "c" })).toEqual({
      token: "[redacted]",
      secret: "[redacted]",
      password: "[redacted]",
    });
  });

  it("truncates on surrogate pairs without splitting them", () => {
    const text = "a".repeat(9) + "😀" + "b";
    const cut = truncateText(text, 10);
    expect(cut).toBe("a".repeat(9) + "…");
    expect(truncateText("short", 10)).toBe("short");
  });

  it("bounds details to the serialized cap", () => {
    const details = sanitizeDetails({ big: "x".repeat(MAX_DETAILS_CHARS * 2) });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(
      MAX_DETAILS_CHARS,
    );
    expect(details).toMatchObject({ truncated: true });
    expect(sanitizeDetails(undefined)).toBeUndefined();
    expect(sanitizeDetails(null)).toBeUndefined();
  });

  it("redacts secret fields inside bodies and caps their size", () => {
    const body = JSON.stringify({
      model: "m",
      api_key: "sk-123",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(sanitizeBody(body)).toBe(
      '{"model":"m","api_key":"[redacted]","messages":[{"role":"user","content":"hi"}]}',
    );
    const oversizedBody = JSON.stringify(
      Array.from({ length: 20 }, () => "y".repeat(2_000)),
    );
    expect(sanitizeBody(oversizedBody)?.length).toBe(MAX_BODY_CHARS);
    expect(sanitizeBody(null)).toBeNull();
    expect(sanitizeBody("")).toBeNull();
  });

  it("redacts escaped JSON body values and every matching field", () => {
    const body = JSON.stringify({
      authorization: 'Bearer \\"quoted\\"',
      nested: [{ token: "one" }, { token: "two" }],
      credential: "secret",
    });
    expect(JSON.parse(sanitizeBody(body)!)).toEqual({
      authorization: "[redacted]",
      nested: [{ token: "[redacted]" }, { token: "[redacted]" }],
      credential: "[redacted]",
    });
  });

  it("does not retain credential values in malformed bodies", () => {
    const body = '{"token":123,"nested":{"password":{"secret":"x"}}, broken';
    expect(sanitizeBody(body)).toBe("[redacted body]");
  });

  it("does not retain values for escaped credential keys in malformed bodies", () => {
    const body = '{"to\\u006ben":"should-not-survive", broken';
    expect(sanitizeBody(body)).toBe("[redacted body]");
  });

  it("keeps the final serialized details object within its cap", () => {
    const details = sanitizeDetails({
      values: Array.from({ length: 5 }, () => '"\\'.repeat(1_000)),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(
      MAX_DETAILS_CHARS,
    );
  });

  it("never throws for invalid dates or hostile objects", () => {
    expect(() => sanitizeValue(new Date("invalid"))).not.toThrow();
    expect(sanitizeValue(new Date("invalid"))).toBe("[invalid date]");

    const throwingGetter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    expect(() => sanitizeValue(throwingGetter)).not.toThrow();

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("boom");
        },
      },
    );
    expect(() => sanitizeValue(throwingProxy)).not.toThrow();

    expect(
      sanitizeDetails({ notANumber: Number.NaN, infinite: Infinity }),
    ).toEqual({
      notANumber: null,
      infinite: null,
    });
  });

  it("summarizes errors without stack traces", () => {
    const error = new TypeError("boom " + "z".repeat(2_000));
    const summary = errorSummary(error);
    expect(summary.startsWith("TypeError: boom")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(1_024);
    expect(errorSummary("plain")).toBe("plain");
  });
});

it("redacts recognizable keys in provider prose and metadata", () => {
  const marker = "sk-proj-EXAMPLE_ONLY_NOT_A_SECRET";
  const body = JSON.stringify({
    error: { message: `Incorrect API key provided: ${marker}` },
  });
  expect(sanitizeBody(body)).not.toContain(marker);
  expect(
    JSON.stringify(sanitizeDetails({ error: `Provider echoed ${marker}` })),
  ).not.toContain(marker);
});

it("retains bounded structured details when only the original value was large", () => {
  const details = sanitizeDetails({ safe: "ok", big: "x".repeat(10_000) });
  expect(details).toMatchObject({ safe: "ok", truncated: true });
  expect(details).toHaveProperty("big");
  expect(details).not.toHaveProperty("preview");
});
it("sanitizes SSE JSON payloads while retaining numeric token counters", () => {
  const result = sanitizeBody(
    'data: {"delta":{"text":"answer"},"access_token":"EXAMPLE_SECRET","usage":{"input_tokens":4}}\n\ndata: [DONE]\n\n',
  );
  expect(result).toContain('"text":"answer"');
  expect(result).toContain('"input_tokens":4');
  expect(result).not.toContain("EXAMPLE_SECRET");
});
