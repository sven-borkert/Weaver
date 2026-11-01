import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouterOutputs } from "~/trpc/react";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "22222222-2222-4222-8222-222222222222";
const ATLAS = "33333333-3333-4333-8333-333333333333";
const HEAD = "0123456789abcdef".padEnd(40, "0");

type QueryOptions = { enabled?: boolean };

const state = vi.hoisted(
  (): {
    data: unknown;
    error: unknown;
    isLoading: boolean;
    options: QueryOptions | undefined;
  } => ({ data: undefined, error: null, isLoading: false, options: undefined }),
);

vi.mock("~/trpc/react", () => ({
  api: {
    knowledge: {
      document: {
        useQuery: (_input: unknown, options: QueryOptions) => {
          state.options = options;
          return {
            data: state.data,
            error: state.error,
            isLoading: state.isLoading,
            refetch: vi.fn(),
          };
        },
      },
    },
  },
}));

import { DocumentIndexPanel } from "./DocumentIndexPanel";

type DocumentIndex = RouterOutputs["knowledge"]["document"];

function indexed(overrides: { models?: boolean } = {}): DocumentIndex {
  const generation = (
    status: "active" | "building",
    dimensions: number,
  ): DocumentIndex["generations"][number] => ({
    id: status === "active" ? "gen-active" : "gen-building",
    status,
    graphCarried: status === "building",
    embedding: {
      model: overrides.models ? `embed-${status}` : null,
      dimensions,
      dimensionMode: status === "active" ? "matryoshka" : "native",
      vectorType: dimensions > 2000 ? "halfvec" : "vector",
    },
    document: {
      status: status === "active" ? "ready" : "pending",
      targetSha: HEAD,
      semanticIndexedSha: status === "active" ? HEAD : null,
      graphIndexedSha: status === "active" ? HEAD : null,
      embeddedChunks: status === "active" ? 2 : 0,
      extractionModel:
        overrides.models && status === "active" ? "extract-model" : null,
      extractionOutdated: status === "active",
      attempts: 1,
      lastAttemptAt: null,
      completedAt: null,
      failureKind: null,
      failureSummary: null,
    },
  });
  return {
    documentId: DOCUMENT,
    headCommitSha: HEAD,
    lights: {
      keyword: "ready",
      semantic: "ready",
      graph: "ready",
      summary: null,
    },
    keyword: {
      status: "ready",
      targetSha: HEAD,
      indexedSha: HEAD,
      chunkCount: 3,
      attempts: 1,
      lastAttemptAt: null,
      completedAt: null,
      failureKind: null,
      failureSummary: null,
    },
    generations: [generation("active", 3072), generation("building", 1024)],
    graph: {
      generationId: "gen-active",
      entityTotal: 51,
      relationTotal: 4,
      entities: [{ id: ATLAS, name: "Atlas", type: "Product", mentions: 2 }],
      truncated: true,
    },
  };
}

const render = (active = true) =>
  renderToStaticMarkup(
    <DocumentIndexPanel
      projectId={PROJECT}
      documentId={DOCUMENT}
      currentSha={HEAD}
      active={active}
    />,
  );

describe("DocumentIndexPanel", () => {
  beforeEach(() => {
    state.data = undefined;
    state.error = null;
    state.isLoading = false;
    state.options = undefined;
  });

  it("only queries while the Index tab is shown", () => {
    render(false);
    expect(state.options?.enabled).toBe(false);
    render(true);
    expect(state.options?.enabled).toBe(true);
  });

  it("shows each layer with embedding dimensions, chunk coverage and graph entities", () => {
    state.data = indexed();
    const html = render();

    expect(html).toContain("Keyword");
    expect(html).toContain("Semantic");
    expect(html).toContain("Graph");
    expect(html).toContain("3 chunks");
    expect(html).toContain("0123456 · current");
    expect(html).toContain("3,072 dimensions · Matryoshka · halfvec");
    expect(html).toContain("2 of 3 chunks");
    expect(html).toContain("1,024 dimensions · Native · vector");
    expect(html).toContain("Graph kept from the previous index");
    expect(html).toContain("51 entities");
    expect(html).toContain("4 relations");
    expect(html).toContain("Atlas");
    expect(html).toContain("Product");
    expect(html).toContain(`/projects/${PROJECT}/graph?focus=${ATLAS}`);
    expect(html).toContain(`/projects/${PROJECT}/graph?document=${DOCUMENT}`);
    expect(html).toContain("Showing the 1 most-mentioned");
    expect(html).toContain("older extraction model");
    expect(html).not.toContain("embed-active");
  });

  it("names the models when the server includes them", () => {
    state.data = indexed({ models: true });
    const html = render();

    expect(html).toContain("embed-active · 3,072 dimensions");
    expect(html).toContain("extract-model");
  });

  it("explains a failure and a project without AI indexing", () => {
    const failed = indexed();
    failed.lights = {
      keyword: "failed",
      semantic: "unavailable",
      graph: "unavailable",
      summary: "Keyword projection failed",
    };
    failed.keyword = {
      ...failed.keyword,
      status: "failed",
      failureKind: "internal",
      failureSummary: "Keyword projection failed",
    };
    failed.generations = [];
    failed.graph = {
      generationId: null,
      entityTotal: 0,
      relationTotal: 0,
      entities: [],
      truncated: false,
    };
    state.data = failed;
    const html = render();

    expect(html).toContain("Keyword projection failed");
    expect(html).toContain("AI indexing is not configured");
  });

  it("reports a load failure", () => {
    state.error = { message: "boom" };
    expect(render()).toContain("Could not load index details");
  });
});
