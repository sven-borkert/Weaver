import { describe, expect, it } from "vitest";

import { listOpenRouterUpstreamProviders } from "./openrouter";

const config = {
  baseUrl: "https://openrouter.ai/api/v1",
  resolveCredential: async () => "router-key",
  requestTimeoutMs: 1000,
};

describe("listOpenRouterUpstreamProviders", () => {
  it("lists distinct upstream endpoint slugs for the selected model", async () => {
    let url = "";
    let authorization = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          data: {
            id: "google/gemini:free",
            endpoints: [
              {
                name: "Google Vertex: Gemini (US East)",
                provider_name: "Google Vertex",
                tag: "google-vertex/us-east5",
              },
              {
                name: "Google Vertex: Gemini (US East)",
                provider_name: "Google Vertex",
                tag: "google-vertex/us-east5",
              },
              { name: "Other", provider_name: "Other", tag: "" },
              {
                name: "Anthropic: Gemini",
                provider_name: "Anthropic",
                tag: "anthropic",
              },
            ],
          },
        }),
      );
    };

    const providers = await listOpenRouterUpstreamProviders(
      config,
      "google/gemini:free",
      fetchImpl,
    );

    expect(url).toBe(
      "https://openrouter.ai/api/v1/models/google/gemini%3Afree/endpoints",
    );
    expect(authorization).toBe("Bearer router-key");
    expect(providers).toEqual([
      {
        label: "Google Vertex: Gemini (US East)",
        slug: "google-vertex/us-east5",
      },
      { label: "Anthropic: Gemini", slug: "anthropic" },
    ]);
  });

  it("rejects malformed model IDs before sending a request", async () => {
    let requests = 0;
    await expect(
      listOpenRouterUpstreamProviders(config, "google/../admin", async () => {
        requests += 1;
        return new Response("{}");
      }),
    ).rejects.toThrow(/model/i);
    expect(requests).toBe(0);
  });

  it("rejects malformed or oversized endpoint responses", async () => {
    await expect(
      listOpenRouterUpstreamProviders(
        config,
        "google/gemini",
        async () => new Response(JSON.stringify({ data: { endpoints: {} } })),
      ),
    ).rejects.toThrow(/provider|endpoint/i);

    await expect(
      listOpenRouterUpstreamProviders(
        config,
        "google/gemini",
        async () =>
          new Response(
            JSON.stringify({
              data: { endpoints: [{ name: "x".repeat(512_000), tag: "x" }] },
            }),
          ),
      ),
    ).rejects.toThrow(/limit|large|response/i);
  });
});
