import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const generation = (
  status: "active" | "building",
  embedding: Record<string, unknown>,
) => ({
  id: `generation-${status}`,
  status,
  documentTotal: 3,
  documentReadyCount: status === "active" ? 3 : 1,
  documentFailedCount: 0,
  createdAt: new Date("2026-09-27T08:00:00.000Z"),
  completedAt: null,
  graphCarried: status === "building",
  embedding,
});

const status = vi.hoisted((): { data: unknown } => ({ data: undefined }));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    knowledge: {
      status: {
        useQuery: () => ({
          data: status.data,
          error: null,
          isLoading: false,
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
      rebuild: { useMutation: () => ({ isPending: false }) },
      retryFailed: { useMutation: () => ({ isPending: false }) },
    },
  },
}));

import { KnowledgeIndexCard } from "./KnowledgeIndexCard";

it("shows the embedding model and dimensions of the active and building generations", () => {
  status.data = {
    readiness: {
      keyword: "ready",
      semantic: "building",
      graph: "ready",
      aiConfigured: true,
    },
    activeGeneration: generation("active", {
      model: "text-embedding-3-large",
      dimensions: 3072,
      dimensionMode: "matryoshka",
      vectorType: "halfvec",
    }),
    buildingGeneration: generation("building", {
      model: "nomic-embed-text",
      dimensions: 768,
      dimensionMode: "native",
      vectorType: "vector",
    }),
    liveDocuments: 3,
    outdatedExtraction: 0,
    lastCompletedAt: null,
    failures: [],
    queue: { queued: 0, active: 0 },
  };

  const html = renderToStaticMarkup(<KnowledgeIndexCard projectId="project" />);

  expect(html).toContain(
    "text-embedding-3-large · 3,072 dimensions · Matryoshka · halfvec",
  );
  expect(html).toContain("nomic-embed-text · 768 dimensions · Native · vector");
});
