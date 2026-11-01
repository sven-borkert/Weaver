import type { ComponentProps, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  verify: vi.fn(),
  clear: vi.fn(),
  invalidate: vi.fn(),
  previewClear: vi.fn(),
  verifyOptions: undefined as
    undefined | { onSuccess: (value: unknown) => void },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      llm: {
        overview: { invalidate: mocked.invalidate },
        previewClearEmbeddingCompatibility: { fetch: mocked.previewClear },
      },
    }),
    llm: {
      verifyEmbeddingCompatibility: {
        useMutation: (options: { onSuccess: (value: unknown) => void }) => {
          mocked.verifyOptions = options;
          return { mutate: mocked.verify, isPending: false };
        },
      },
      clearEmbeddingCompatibility: {
        useMutation: () => ({ mutate: mocked.clear, isPending: false }),
      },
    },
  },
}));

import { VectorCompatibilitySection } from "./VectorCompatibilitySection";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof VectorCompatibilitySection>;
const candidates: Props["candidates"] = [
  {
    id: "m2",
    label: "Local Ollama › qwen3-embedding:4b",
    embeddingDimensions: 1536,
    embeddingDimensionMode: "native",
  },
  {
    id: "m3",
    label: "Local Ollama › small-embedding",
    embeddingDimensions: 768,
    embeddingDimensionMode: "native",
  },
];
function model(verified: boolean): Props["model"] {
  return {
    id: "m1",
    connectionId: "c1",
    providerModelId: "qwen/qwen3-embedding-4b",
    displayName: "Qwen3 Embedding 4B",
    contextWindow: null,
    maxOutputTokens: null,
    embeddingDimensions: 1536,
    embeddingDimensionMode: "native",
    upstreamProvider: null,
    capabilities: ["embedding"],
    inputCostMicrosPerMillion: null,
    outputCostMicrosPerMillion: null,
    currency: null,
    vectorSpaceKey: verified ? "k".repeat(64) : null,
    vectorSpaceReferenceModelId: verified ? "m2" : null,
    vectorSpaceVerifiedAt: verified ? new Date("2026-09-26T08:00:00Z") : null,
    vectorSpaceMinSimilarity: verified ? 0.9941 : null,
  };
}

async function mount(verified: boolean) {
  mocked.verify.mockReset();
  mocked.clear.mockReset();
  mocked.previewClear.mockReset();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <VectorCompatibilitySection
        model={model(verified)}
        candidates={candidates}
      />,
    );
  });
  return renderer;
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.find(
    (node) => node.type === "button" && node.props.children === label,
  );

const click = async (renderer: ReactTestRenderer, label: string) =>
  act(async () => {
    await (button(renderer, label).props.onClick as () => unknown)();
  });

describe("VectorCompatibilitySection", () => {
  it("shows a verified pair and removes it when the index is unaffected", async () => {
    const renderer = await mount(true);
    mocked.previewClear.mockResolvedValue({ effect: "none", projects: 0 });
    expect(text(renderer)).toContain(
      "Compatible with Local Ollama › qwen3-embedding:4b",
    );
    expect(text(renderer)).toContain("0.994");
    await click(renderer, "Remove compatibility");
    expect(mocked.previewClear).toHaveBeenCalledWith(
      { modelId: "m1" },
      { staleTime: 0 },
    );
    expect(mocked.clear).toHaveBeenCalledWith({ modelId: "m1" });
    expect(text(renderer)).not.toContain("rebuilds the knowledge index");
    await act(async () => renderer.unmount());
  });

  it("asks before a removal that rebuilds the knowledge index", async () => {
    const renderer = await mount(true);
    mocked.previewClear.mockResolvedValue({ effect: "reindex", projects: 4 });

    await click(renderer, "Remove compatibility");
    expect(mocked.clear).not.toHaveBeenCalled();
    expect(text(renderer)).toContain(
      "Removing compatibility rebuilds the knowledge index of 4 projects.",
    );
    await click(renderer, "Cancel");
    expect(text(renderer)).not.toContain("rebuilds the knowledge index");
    expect(mocked.clear).not.toHaveBeenCalled();

    await click(renderer, "Remove compatibility");
    await click(renderer, "Remove");
    expect(mocked.clear).toHaveBeenCalledTimes(1);
    expect(mocked.clear).toHaveBeenCalledWith({ modelId: "m1" });
    expect(text(renderer)).not.toContain("rebuilds the knowledge index");
    await act(async () => renderer.unmount());
  });

  it("offers only comparable references and reports an incompatible result", async () => {
    const renderer = await mount(false);
    expect(text(renderer)).toContain("qwen3-embedding:4b");
    expect(text(renderer)).not.toContain("small-embedding");
    const select = renderer.root.find(
      (node) => node.type === "div" && node.props["data-select"] === true,
    );
    await act(async () =>
      (select.props.onValueChange as (value: string) => void)("m2"),
    );
    await act(async () => {
      (button(renderer, "Verify").props.onClick as () => void)();
    });
    expect(mocked.verify).toHaveBeenCalledWith({
      modelId: "m1",
      referenceModelId: "m2",
    });
    await act(async () =>
      mocked.verifyOptions!.onSuccess({
        outcome: "incompatible",
        minSimilarity: 0.41,
        meanSimilarity: 0.52,
        durationMs: 900,
        summary: "different spaces",
        reindexProjects: 0,
      }),
    );
    expect(text(renderer)).toContain("Not compatible (min similarity 0.410)");
    await act(async () => renderer.unmount());
  });
});
