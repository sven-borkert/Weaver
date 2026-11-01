import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cachedOverview = {
  encryptionConfigured: true,
  connections: [
    {
      id: "connection-1",
      name: "Classified provider",
      providerType: "openrouter" as const,
      endpoint: "https://openrouter.ai/api/v1",
      requestTimeoutMs: 30_000,
      enabled: true,
      credentialKeyVersion: 1,
      credentialUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      lastTestAt: null,
      lastTestOutcome: null,
      lastTestSummary: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      models: [
        {
          id: "model-1",
          connectionId: "connection-1",
          providerModelId: "gpt-test",
          displayName: "Classified model",
          contextWindow: 128_000,
          maxOutputTokens: 4096,
          embeddingDimensions: null,
          embeddingDimensionMode: "native" as const,
          upstreamProvider: "anthropic",
          capabilities: ["chat" as const],
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: null,
          currency: null,
        },
        {
          id: "model-2",
          connectionId: "connection-1",
          providerModelId: "embedding-test",
          displayName: "Resizable embeddings",
          contextWindow: null,
          maxOutputTokens: null,
          embeddingDimensions: 1536,
          embeddingDimensionMode: "matryoshka" as const,
          upstreamProvider: null,
          capabilities: ["embedding" as const],
          inputCostMicrosPerMillion: null,
          outputCostMicrosPerMillion: null,
          currency: null,
        },
      ],
    },
  ],
  routes: [
    {
      purpose: "assistant" as const,
      model: null,
      health: "unassigned" as const,
      updatedAt: null,
    },
  ],
};

const mocked = vi.hoisted(() => ({
  query: {
    data: undefined as typeof cachedOverview | undefined,
    error: undefined as { data: { code: string } } | undefined,
    isLoading: false,
    refetch: vi.fn(),
  },
  settingsQuery: {
    data: undefined as
      { doclingBaseUrl: string | null; doclingTimeoutMs: number } | undefined,
    error: undefined as { data: { code: string } } | undefined,
    isLoading: false,
    refetch: vi.fn(),
  },
  mutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      llm: { overview: { invalidate: vi.fn() } },
      ingestionAdmin: { getSettings: { invalidate: vi.fn() } },
    }),
    llm: {
      overview: { useQuery: () => mocked.query },
      testConnection: { useMutation: mocked.mutation },
      importModels: { useMutation: mocked.mutation },
      testModel: { useMutation: mocked.mutation },
      deleteConnection: { useMutation: mocked.mutation },
      deleteModel: { useMutation: mocked.mutation },
      setRoute: { useMutation: mocked.mutation },
    },
    ingestionAdmin: {
      getSettings: { useQuery: () => mocked.settingsQuery },
      setSettings: { useMutation: mocked.mutation },
      probeDocling: { useMutation: mocked.mutation },
    },
  },
}));

import { AiAdminPage } from "./AiAdminPage";

describe("AiAdminPage access-safe presentation", () => {
  beforeEach(() => {
    mocked.query.data = cachedOverview;
    mocked.query.error = undefined;
    mocked.query.isLoading = false;
    mocked.settingsQuery.data = {
      doclingBaseUrl: "http://docling.test:5001",
      doclingTimeoutMs: 120_000,
    };
    mocked.settingsQuery.error = undefined;
    mocked.settingsQuery.isLoading = false;
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "hides cached administration details after a %s error",
    (code) => {
      mocked.query.error = { data: { code } };

      const html = renderToStaticMarkup(<AiAdminPage />);

      expect(html).toContain("AI administration unavailable");
      expect(html).not.toContain("Classified provider");
      expect(html).not.toContain("Classified model");
      expect(html).not.toContain("openrouter.ai");
    },
  );

  it("shows declared model limits in the models table", () => {
    const html = renderToStaticMarkup(<AiAdminPage />);

    expect(html).toContain("Max output");
    expect(html).toContain("128000");
    expect(html).toContain("4096");
    expect(html).toContain("Matryoshka");
    expect(html).toContain("Upstream: anthropic");
  });

  it("keeps cached administration details after a transient refresh error", () => {
    mocked.query.error = { data: { code: "INTERNAL_SERVER_ERROR" } };

    const html = renderToStaticMarkup(<AiAdminPage />);

    expect(html).toContain("Classified provider");
    expect(html).not.toContain("AI administration unavailable");
  });

  it("renders the Docling endpoint from settings with a connection test", () => {
    mocked.query.data = cachedOverview;
    const markup = renderToStaticMarkup(<AiAdminPage />);
    expect(markup).toContain("Document parsing");
    expect(markup).toContain('value="http://docling.test:5001"');
    expect(markup).toContain("Test connection");
  });

  it("shows an error state instead of a blank form when Docling settings fail to load", () => {
    mocked.settingsQuery.data = undefined;
    mocked.settingsQuery.error = { data: { code: "INTERNAL_SERVER_ERROR" } };

    const markup = renderToStaticMarkup(<AiAdminPage />);

    expect(markup).toContain("Could not load document parsing settings.");
    expect(markup).not.toContain("doclingBaseUrl");
    expect(markup).toContain("Retry");
  });
});
