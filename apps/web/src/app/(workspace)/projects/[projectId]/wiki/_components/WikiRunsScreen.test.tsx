import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WikiRunsScreen } from "./WikiRunsScreen";
import { wikiCost, wikiDuration, wikiRunOutcome } from "./wikiRunPresentation";

type Query = { data: unknown; error: unknown };
const mocked = vi.hoisted((): Record<"project" | "runs" | "usage", Query> => ({
  project: { data: undefined, error: null },
  runs: { data: undefined, error: null },
  usage: { data: undefined, error: null },
}));
vi.mock("~/trpc/react", () => {
  const mutation = {
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
  };
  return {
    api: {
      useUtils: () => ({}),
      project: { get: { useQuery: () => mocked.project } },
      wiki: {
        runs: { useQuery: () => mocked.runs },
        usage: { useQuery: () => mocked.usage },
        run: { useQuery: () => ({ data: undefined, error: null }) },
        revertRun: mutation,
        cancelRun: mutation,
      },
    },
  };
});

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "ingest",
  trigger: "manual",
  status: "succeeded",
  stopReason: null,
  errorCode: null,
  errorMessage: null,
  startedBy: "Anna",
  startedAt: new Date(0),
  endedAt: new Date(180_000),
  items: 2,
  pagesCreated: 3,
  pagesPatched: 4,
  usageTokens: 12_345,
  costMicros: 1_500_000n,
  currency: "USD",
  indexingCostMicros: null as bigint | null,
};

const render = () =>
  renderToStaticMarkup(
    <WikiRunsScreen projectId="22222222-2222-4222-8222-222222222222" />,
  );

describe("WikiRunsScreen", () => {
  beforeEach(() => {
    mocked.project = { data: { myRole: "Editor" }, error: null };
    mocked.runs = { data: { runs: [run], nextCursor: null }, error: null };
    mocked.usage = {
      data: {
        tokens: 99,
        costMicros: 0n,
        currency: "USD",
        indexingCostMicros: null,
      },
      error: null,
    };
  });

  it("lists a run with its counts and hides indexing cost below Maintainer", () => {
    const html = render();
    expect(html).toContain("ingest · manual");
    expect(html).toContain("Succeeded");
    expect(html).toContain("3 created");
    expect(html).toContain("4 patched");
    expect(html).toContain("12,345 tokens");
    expect(html).toContain("1.50 USD");
    expect(html).not.toContain("indexing");
  });

  it("shows indexing cost when the server sends it", () => {
    mocked.runs = {
      data: {
        runs: [{ ...run, indexingCostMicros: 250_000n }],
        nextCursor: null,
      },
      error: null,
    };
    expect(render()).toContain("indexing 0.25 USD");
  });

  it("does not offer maintenance or classify yet", () => {
    const html = render();
    expect(html).not.toContain("Run maintenance now");
    expect(html).not.toContain("Classify existing pages");
  });

  it("says when there is nothing and when access is gone", () => {
    mocked.runs = { data: { runs: [], nextCursor: null }, error: null };
    expect(render()).toContain("No runs yet");
    mocked.runs = {
      data: undefined,
      error: { data: { code: "NOT_FOUND" } },
    };
    expect(render()).toContain("do not have access");
  });
});

describe("wikiRunPresentation", () => {
  it("never shows a code", () => {
    expect(
      wikiRunOutcome({
        status: "failed",
        stopReason: null,
        errorCode: "ROUTE_UNSUITABLE",
        errorMessage: "raw",
      }),
    ).toContain("Administration");
    expect(
      wikiRunOutcome({
        status: "stopped",
        stopReason: "destructive_budget",
        errorCode: null,
        errorMessage: null,
      }),
    ).toContain("page limits");
    expect(
      wikiRunOutcome({
        status: "stopped",
        stopReason: "unknown_reason",
        errorCode: null,
        errorMessage: null,
      }),
    ).not.toContain("unknown_reason");
  });

  it("formats duration and cost", () => {
    expect(wikiDuration(new Date(0), new Date(45_000))).toBe("45 s");
    expect(wikiDuration(new Date(0), new Date(180_000))).toBe("3 min");
    expect(wikiDuration(new Date(0), null)).toBe("");
    expect(wikiCost(0n, null)).toBe("0.00");
    expect(wikiCost(1_234n, "USD")).toBe("0.0012 USD");
  });
});
