import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => (
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
      createConnection: {
        useMutation: () => ({ mutate: mocked.mutate, isPending: false }),
      },
      updateConnection: {
        useMutation: () => ({ mutate: mocked.mutate, isPending: false }),
      },
    },
  },
}));
import { ConnectionDialog } from "./ConnectionDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Local",
  providerType: "ollama" as const,
  endpoint: "http://127.0.0.1:11434",
  requestTimeoutMs: 30_000,
  enabled: true,
  credentialKeyVersion: 1,
  credentialUpdatedAt: new Date(),
  lastTestAt: null,
  lastTestOutcome: null,
  lastTestSummary: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  models: [],
};
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
async function mount(
  providerType:
    | "ollama"
    | "lmstudio"
    | "openai_compatible"
    | "openrouter"
    | null = "ollama",
) {
  await act(async () => {
    renderer = create(
      <ConnectionDialog
        open
        connection={providerType ? { ...base, providerType } : undefined}
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
beforeEach(() => {
  mocked.mutate.mockReset();
  nodes.clear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("local connection credential choices", () => {
  it.each(["ollama", "lmstudio"] as const)(
    "sends an explicit empty credential after opting into a keyless %s destination",
    async (provider) => {
      await mount(provider);
      await change("endpoint", "http://127.0.0.1:9999");
      const choice = renderer.root.findByProps({
        id: "llm-connection-no-credential",
      });
      await act(async () => {
        (choice.props.onChange as (event: unknown) => void)({
          target: { checked: true },
        });
      });
      await submit();
      expect(mocked.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "http://127.0.0.1:9999",
          credential: "",
        }),
      );
    },
  );

  it("does not silently discard an existing local credential on an origin change", async () => {
    await mount();
    await change("endpoint", "http://127.0.0.1:9999");
    await submit();
    expect(mocked.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ credential: null }),
    );
  });

  it("keeps a blank credential for same-origin edits and offers no keyless replacement", async () => {
    await mount();
    await change("name", "Renamed");
    expect(
      renderer.root.findAllByProps({ id: "llm-connection-no-credential" }),
    ).toHaveLength(0);
    await submit();
    expect(mocked.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ credential: null, name: "Renamed" }),
    );
  });

  it("never offers keyless replacement for an authenticated provider", async () => {
    await mount("openai_compatible");
    await change("endpoint", "https://other.example/v1");
    expect(
      renderer.root.findAllByProps({ id: "llm-connection-no-credential" }),
    ).toHaveLength(0);
    await change("credential", "replacement-key");
    await submit();
    expect(mocked.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ credential: "replacement-key" }),
    );
  });
});

describe("OpenRouter connection setup", () => {
  it("creates with the fixed endpoint and only an API key", async () => {
    await mount(null);
    const providerSelect = renderer.root.find(
      (node) => node.type === "div" && node.props.value === "openai",
    );
    await act(async () => {
      (providerSelect.props.onValueChange as (value: string) => void)(
        "openrouter",
      );
    });
    await change("credential", "router-key");
    await submit();

    expect(mocked.mutate).toHaveBeenCalledWith({
      name: "OpenRouter",
      providerType: "openrouter",
      endpoint: null,
      credential: "router-key",
      requestTimeoutMs: 30_000,
      enabled: true,
    });
  });
});
