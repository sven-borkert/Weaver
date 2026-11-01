import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  previewOptions: undefined as undefined | { staleTime?: number },
}));
vi.mock("~/components/ui/select", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Select = ({
    children,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-select {...props}>
      {children}
    </div>
  );
  return {
    Select,
    SelectContent: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: Container,
  };
});
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ llm: { overview: { invalidate: mocked.invalidate } } }),
    llm: {
      setRoute: {
        useMutation: () => ({ mutate: mocked.mutate, isPending: false }),
      },
      previewKnowledgeRouteChange: {
        useQuery: (_input: unknown, options: { staleTime?: number }) => {
          mocked.previewOptions = options;
          return {
            data: { effect: "reindex", projects: 3 },
            isFetching: false,
            error: null,
          };
        },
      },
    },
  },
}));

import { RoutesCard } from "./RoutesCard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof RoutesCard>;
const model = {
  connectionId: "connection-1",
  connectionName: "OpenRouter",
  providerType: "openrouter",
  endpoint: "https://openrouter.ai/api/v1",
  requestTimeoutMs: 30_000,
  enabled: true,
  modelId: "model-a",
  providerModelId: "anthropic/example",
  displayName: "Shared model",
  contextWindow: 128_000,
  maxOutputTokens: null,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  reasoningMode: "high",
  capabilities: ["chat", "tool_use", "json_output"],
  inputCostMicrosPerMillion: null,
  outputCostMicrosPerMillion: null,
  currency: null,
  upstreamProvider: "anthropic",
} as NonNullable<Props["routes"][number]["model"]>;

async function mount(purpose: "assistant" | "knowledge_embedding") {
  mocked.mutate.mockReset();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RoutesCard
        connections={
          [
            {
              name: "OpenRouter",
              models: [
                { id: "model-a", displayName: "Shared model" },
                { id: "model-b", displayName: "Another model" },
              ],
            },
          ] as Props["connections"]
        }
        routes={
          [
            {
              purpose,
              model,
              reasoningMode: "high",
              health: "ready",
              updatedAt: null,
            },
          ] as Props["routes"]
        }
      />,
    );
  });
  return renderer;
}

function selects(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.type === "div" && node.props["data-select"] === true,
  );
}

describe("route reasoning controls", () => {
  it("preserves the route effort when changing its model", async () => {
    const renderer = await mount("assistant");
    await act(async () => {
      (selects(renderer)[0]!.props.onValueChange as (value: string) => void)(
        "model-b",
      );
    });

    expect(mocked.mutate).toHaveBeenCalledWith({
      purpose: "assistant",
      modelId: "model-b",
      reasoningMode: "high",
    });
    await act(async () => renderer.unmount());
  });

  it("can disable thinking on one route without changing the model", async () => {
    const renderer = await mount("assistant");
    await act(async () => {
      (selects(renderer)[1]!.props.onValueChange as (value: string) => void)(
        "none",
      );
    });

    expect(mocked.mutate).toHaveBeenCalledWith({
      purpose: "assistant",
      modelId: "model-a",
      reasoningMode: "none",
    });
    await act(async () => renderer.unmount());
  });

  it("does not offer thinking effort on an embedding route", async () => {
    const renderer = await mount("knowledge_embedding");
    expect(selects(renderer)).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it("asks before switching the knowledge embedding route", async () => {
    const renderer = await mount("knowledge_embedding");
    await act(async () => {
      (selects(renderer)[0]!.props.onValueChange as (value: string) => void)(
        "model-b",
      );
    });
    expect(mocked.mutate).not.toHaveBeenCalled();
    expect(mocked.previewOptions).toMatchObject({ staleTime: 0 });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Re-embeds the knowledge index of 3 projects. The graph is kept; semantic search shows keyword results until each project finishes.",
    );
    const confirm = renderer.root.find(
      (node) =>
        Boolean(node.props.onClick) && node.props.children === "Switch model",
    );
    await act(async () => {
      (confirm.props.onClick as () => void)();
    });
    expect(mocked.mutate).toHaveBeenCalledWith({
      purpose: "knowledge_embedding",
      modelId: "model-b",
      reasoningMode: "provider_default",
    });
    await act(async () => renderer.unmount());
  });
});
