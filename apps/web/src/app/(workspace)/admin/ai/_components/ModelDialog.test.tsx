import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  detect: vi.fn(),
  invalidate: vi.fn(),
  providersQuery: vi.fn(() => ({
    data: [
      { label: "Anthropic", slug: "anthropic" },
      { label: "Together", slug: "together" },
    ],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  })),
  previewQuery: vi.fn(() => ({
    data: { effect: "reembed", projects: 2 },
    isFetching: false,
    error: null,
  })),
}));
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
    DialogClose: Container,
  };
});
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
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ llm: { overview: { invalidate: mocked.invalidate } } }),
    llm: {
      createModel: {
        useMutation: () => ({ mutate: mocked.create, isPending: false }),
      },
      updateModel: {
        useMutation: () => ({ mutate: mocked.update, isPending: false }),
      },
      detectEmbeddingDimensions: {
        useMutation: () => ({ mutate: mocked.detect, isPending: false }),
      },
      listOpenRouterUpstreamProviders: { useQuery: mocked.providersQuery },
      previewKnowledgeModelChange: { useQuery: mocked.previewQuery },
    },
  },
}));

import { ModelDialog } from "./ModelDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ModelDialog>;
const savedModel = {
  id: "model-1",
  connectionId: "connection-1",
  providerModelId: "anthropic/example",
  displayName: "Shared model",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  embeddingDimensions: null,
  embeddingDimensionMode: "native",
  upstreamProvider: "anthropic",
  capabilities: ["chat", "tool_use", "json_output"],
  inputCostMicrosPerMillion: null,
  outputCostMicrosPerMillion: null,
  currency: null,
} as Props["model"];

type NodeMock = {
  name: string;
  type: string;
  value: string;
  checked: boolean;
  focus: () => void;
  select: () => void;
};
let renderer: ReactTestRenderer;
const nodes = new Map<string, NodeMock>();

async function mount(providerType: "openrouter" | "openai" = "openrouter") {
  await act(async () => {
    renderer = create(
      <ModelDialog
        open
        connectionId="connection-1"
        providerType={providerType}
        model={savedModel}
        onOpenChange={vi.fn()}
        returnFocusRef={{ current: null }}
        fallbackFocusRef={{ current: null }}
      />,
      {
        createNodeMock: ({ type, props }) => {
          if (type !== "input") return {};
          const attributes = props as { name?: string; type?: string };
          const node = {
            name: attributes.name ?? "",
            type: attributes.type ?? "text",
            value: "",
            checked: false,
            focus: vi.fn(),
            select: vi.fn(),
          };
          nodes.set(node.name, node);
          return node;
        },
      },
    );
  });
}

async function change(name: string, value: string) {
  const input = renderer.root.findByProps({ name });
  const node = nodes.get(name)!;
  node.value = value;
  await act(async () => {
    await (input.props.onChange as (event: unknown) => unknown)({
      type: "change",
      target: node,
    });
  });
}

async function submit() {
  await act(async () => {
    await (
      renderer.root.findByType("form").props.onSubmit as (
        event: unknown,
      ) => unknown
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}

function upstreamSelect() {
  return renderer.root.find(
    (node) =>
      node.type === "div" &&
      node.props["data-select"] === true &&
      typeof node.props.value === "string" &&
      ["anthropic", "together", "__automatic__"].includes(node.props.value),
  );
}

beforeEach(() => {
  mocked.create.mockReset();
  mocked.update.mockReset();
  mocked.detect.mockReset();
  mocked.providersQuery.mockClear();
  nodes.clear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("OpenRouter model routing", () => {
  it("saves a selected upstream provider", async () => {
    await mount();
    expect(upstreamSelect().props.value).toBe("anthropic");
    await act(async () => {
      (upstreamSelect().props.onValueChange as (value: string) => void)(
        "together",
      );
    });
    await submit();

    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "model-1",
        upstreamProvider: "together",
      }),
    );
    expect(mocked.providersQuery).toHaveBeenCalledWith(
      { connectionId: "connection-1", providerModelId: "anthropic/example" },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("clears the old upstream pin when the model ID changes", async () => {
    await mount();
    await change("providerModelId", "anthropic/other");
    expect(upstreamSelect().props.value).toBe("__automatic__");
    await submit();

    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerModelId: "anthropic/other",
        upstreamProvider: null,
      }),
    );
  });

  it("keeps upstream selection out of non-OpenRouter model forms", async () => {
    await mount("openai");
    expect(
      renderer.root.findAllByProps({ id: "llm-model-upstream-provider" }),
    ).toHaveLength(0);
    await submit();
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamProvider: null }),
    );
  });
});

const embeddingModel = {
  ...savedModel,
  providerModelId: "qwen/qwen3-embedding-4b",
  displayName: "Qwen embedding",
  contextWindow: null,
  maxOutputTokens: null,
  embeddingDimensions: 1536,
  embeddingDimensionMode: "matryoshka",
  upstreamProvider: null,
  capabilities: ["embedding"],
} as Props["model"];

async function mountEmbedding(routed: boolean, model = embeddingModel) {
  await act(async () => {
    renderer = create(
      <ModelDialog
        open
        connectionId="connection-1"
        providerType="openai"
        model={model}
        routedForKnowledgeEmbedding={routed}
        onOpenChange={vi.fn()}
        returnFocusRef={{ current: null }}
        fallbackFocusRef={{ current: null }}
      />,
      {
        createNodeMock: ({ type, props }) => {
          if (type !== "input") return {};
          const attributes = props as { name?: string; type?: string };
          const node = {
            name: attributes.name ?? "",
            type: attributes.type ?? "text",
            value: "",
            checked: false,
            focus: vi.fn(),
            select: vi.fn(),
          };
          nodes.set(node.name, node);
          return node;
        },
      },
    );
  });
}

type DetectCallbacks = {
  onSuccess: (result: { dimensions: number }) => void;
  onError: () => void;
};

async function setMatryoshka(checked: boolean) {
  const checkbox = renderer.root.findByProps({ id: "llm-model-matryoshka" });
  await act(async () => {
    (checkbox.props.onChange as (event: unknown) => void)({
      target: { checked },
    });
  });
}

describe("native embedding size", () => {
  it("fills the detected native size when Matryoshka is turned off", async () => {
    mocked.detect.mockImplementation(
      (_input: unknown, callbacks: DetectCallbacks) =>
        callbacks.onSuccess({ dimensions: 2560 }),
    );
    await mountEmbedding(false);
    await setMatryoshka(false);

    expect(mocked.detect).toHaveBeenCalledWith(
      {
        connectionId: "connection-1",
        providerModelId: "qwen/qwen3-embedding-4b",
        upstreamProvider: null,
      },
      expect.anything(),
    );
    await submit();
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingDimensions: 2560,
        embeddingDimensionMode: "native",
      }),
    );
  });

  it("keeps the size and explains when detection fails", async () => {
    mocked.detect.mockImplementation(
      (_input: unknown, callbacks: DetectCallbacks) => callbacks.onError(),
    );
    await mountEmbedding(false);
    await setMatryoshka(false);

    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Could not detect the native size; enter it manually.",
    );
    await submit();
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingDimensions: 1536,
        embeddingDimensionMode: "native",
      }),
    );
  });

  it("asks the provider nothing when Matryoshka is turned on", async () => {
    await mountEmbedding(false, {
      ...embeddingModel,
      embeddingDimensionMode: "native",
    } as Props["model"]);
    await setMatryoshka(true);

    expect(mocked.detect).not.toHaveBeenCalled();
  });
});

describe("routed embedding model edits", () => {
  it("asks before a size change re-embeds the knowledge index", async () => {
    await mountEmbedding(true);
    await change("embeddingDimensions", "1024");
    await submit();

    expect(mocked.update).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Re-embeds the knowledge index of 2 projects.",
    );
    const confirm = renderer.root.find(
      (node) =>
        Boolean(node.props.onClick) &&
        node.props.children === "Save and re-embed",
    );
    await act(async () => {
      (confirm.props.onClick as () => void)();
    });
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "model-1",
        embeddingDimensions: 1024,
      }),
    );
  });

  it("locks the form fields while confirming and unlocks on Back", async () => {
    await mountEmbedding(true);
    await change("embeddingDimensions", "1024");
    await submit();

    expect(
      renderer.root.findByProps({ "data-testid": "model-form-fields" }).props
        .disabled,
    ).toBe(true);

    const back = renderer.root.find(
      (node) => Boolean(node.props.onClick) && node.props.children === "Back",
    );
    await act(async () => {
      (back.props.onClick as () => void)();
    });

    expect(
      renderer.root.findByProps({ "data-testid": "model-form-fields" }).props
        .disabled,
    ).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "Re-embeds the knowledge index",
    );

    await submit();
    const confirm = renderer.root.find(
      (node) =>
        Boolean(node.props.onClick) &&
        node.props.children === "Save and re-embed",
    );
    await act(async () => {
      (confirm.props.onClick as () => void)();
    });
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingDimensions: 1024 }),
    );
  });

  it("saves a routed model's display name without asking", async () => {
    await mountEmbedding(true);
    await change("displayName", "Renamed");
    await submit();
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Renamed" }),
    );
  });

  it("saves an unrouted embedding model's size without asking", async () => {
    await mountEmbedding(false);
    await change("embeddingDimensions", "1024");
    await submit();
    expect(mocked.update).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingDimensions: 1024 }),
    );
  });
});
