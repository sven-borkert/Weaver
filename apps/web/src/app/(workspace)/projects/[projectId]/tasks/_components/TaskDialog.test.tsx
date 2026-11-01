import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalInput } from "@weaver/core/externalMcp/types";
import type { ScopeRequest } from "@weaver/core/assistant/scopeSchema";
const mocked = vi.hoisted(() => ({
  mutate: vi.fn(),
  create: vi.fn(),
  pending: false,
  options: undefined as
    | {
        onError: (error: {
          data?: { field?: string };
          message: string;
        }) => void;
      }
    | undefined,
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
}));
vi.mock("../../documents/_components/FolderPicker", () => ({
  FolderPicker: () => null,
}));
vi.mock("~/components/assistant/ScopeSelector", () => ({
  ScopeSelector: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      scheduledTask: {
        listForProject: { invalidate: vi.fn() },
        listMine: { invalidate: vi.fn() },
        get: { invalidate: vi.fn() },
      },
    }),
    folder: { tree: { useQuery: () => ({ data: { folders: [] } }) } },
    project: { list: { useQuery: () => ({ data: [] }) } },
    account: {
      me: {
        useQuery: () => ({
          data: { name: "Owner", email: "owner@weaver.local" },
        }),
      },
    },
    document: {
      list: { useQuery: () => ({ data: { items: [] } }) },
      get: { useQuery: () => ({ data: undefined }) },
    },
    scheduledTask: {
      create: {
        useMutation: () => ({
          mutate: mocked.create,
          isPending: mocked.pending,
        }),
      },
      update: {
        useMutation: (options: typeof mocked.options) => {
          mocked.options = options;
          return { mutate: mocked.mutate, isPending: mocked.pending };
        },
      },
    },
    externalMcp: {
      list: { useQuery: () => ({ data: { items: [] } }) },
      availability: {
        useQuery: () => ({
          error: new Error("Unconfigured"),
          isFetching: false,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));
import { TaskDialog } from "./TaskDialog";
import { ExternalInputsEditor } from "./ExternalInputsEditor";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const input: ExternalInput = {
  name: "Counts",
  toolId: "11111111-1111-4111-8111-111111111111",
  arguments: { hours: { kind: "literal", value: 24 } },
};
const task = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Daily",
  instruction: "Report",
  outputFolderPath: [],
  schedule: { kind: "daily" as const, hour: 7, minute: 0 },
  timezone: "UTC",
  scopeRequest: { kind: "project", projectId: "source" } as ScopeRequest,
  externalInputs: [input],
};
type NodeMock = {
  name: string;
  value: string;
  type: string;
  focus: () => void;
  validationMessage: string;
  setCustomValidity: (message: string) => void;
};
const nodes = new Map<string, NodeMock>();
function props(detail = task, open = true) {
  return {
    projectId: "output",
    task: detail as never,
    open,
    onOpenChange: vi.fn(),
  };
}
async function mount(detail = task) {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<TaskDialog {...props(detail)} />, {
      createNodeMock: (element) => {
        if (element.type !== "input" && element.type !== "textarea") return {};
        const p = element.props as {
          name?: string;
          type?: string;
          "aria-label"?: string;
        };
        const node = {
          name: p.name ?? "",
          type: p.type ?? "text",
          value: "",
          focus: vi.fn(),
          validationMessage: "",
          setCustomValidity(message: string) {
            this.validationMessage = message;
          },
        };
        nodes.set(p["aria-label"] ?? node.name, node);
        return node;
      },
    });
  });
  return r;
}
async function submit(r: ReactTestRenderer, valid?: boolean) {
  const handler = r.root.findByType("form").props.onSubmit as (event: {
    preventDefault: () => void;
    persist: () => void;
    currentTarget: { reportValidity: () => boolean };
  }) => void;
  await act(async () => {
    handler({
      preventDefault: vi.fn(),
      persist: vi.fn(),
      currentTarget: {
        reportValidity: () =>
          valid ??
          r.root.findAllByType("textarea").every((field) => {
            const props = field.props as {
              "aria-label"?: string;
              name?: string;
            };
            return !nodes.get(props["aria-label"] ?? props.name ?? "")
              ?.validationMessage;
          }),
      },
    });
  });
}
async function changeName(r: ReactTestRenderer, value: string) {
  const node = nodes.get("name")!;
  node.value = value;
  const change = r.root.findByProps({ name: "name" }).props
    .onChange as (event: { type: string; target: NodeMock }) => void;
  await act(async () => {
    change({ type: "change", target: node });
  });
}
beforeEach(() => {
  mocked.mutate.mockReset();
  mocked.create.mockReset();
  mocked.pending = false;
  nodes.clear();
});
describe("TaskDialog external input lifecycle", () => {
  it.each(["Move input 2 up", "Remove input 1"])(
    "retains invalid JSON and pending period text when %s, blocking real form submission",
    async (action) => {
      const r = await mount({
        ...task,
        externalInputs: [
          input,
          {
            ...input,
            name: "Second",
            arguments: { days: { kind: "literal", value: 7 } },
          },
        ],
      });
      const pending = r.root.findByProps({
        "aria-label": "Input 2 period property",
      }).props.onChange as (event: { target: { value: string } }) => void;
      await act(async () => pending({ target: { value: "report_since" } }));
      const native = nodes.get("Input 2 JSON arguments")!;
      native.value = '{"unfinished":';
      const edit = r.root.findByProps({
        "aria-label": "Input 2 JSON arguments",
      }).props.onChange as (event: { target: NodeMock }) => void;
      await act(async () => edit({ target: native }));
      expect(native.validationMessage).toContain("valid JSON object");
      const move = r.root
        .findAllByType("button")
        .find(
          (node) =>
            node.children
              .filter((child) => typeof child === "string")
              .join("") === action,
        )!.props.onClick as () => void;
      await act(async () => move());
      expect(
        r.root.findByProps({ "aria-label": "Input 1 name" }).props.value,
      ).toBe("Second");
      expect(
        r.root.findByProps({ "aria-label": "Input 1 JSON arguments" }).props
          .value,
      ).toBe('{"unfinished":');
      expect(
        r.root.findByProps({ "aria-label": "Input 1 period property" }).props
          .value,
      ).toBe("report_since");
      expect(nodes.get("Input 1 JSON arguments")!.validationMessage).toContain(
        "valid JSON object",
      );
      await submit(r);
      expect(mocked.mutate).not.toHaveBeenCalled();
      const repairNode = nodes.get("Input 1 JSON arguments")!;
      repairNode.value = '{"days":8}';
      const repair = r.root.findByProps({
        "aria-label": "Input 1 JSON arguments",
      }).props.onChange as (event: { target: NodeMock }) => void;
      await act(async () => repair({ target: repairNode }));
      await submit(r);
      expect(mocked.mutate).toHaveBeenCalledOnce();
      const payload = mocked.mutate.mock.calls[0]![0] as {
        externalInputs: ExternalInput[];
      };
      expect(payload.externalInputs[0]).toEqual({
        name: "Second",
        toolId: input.toolId,
        arguments: { days: { kind: "literal", value: 8 } },
      });
      await act(async () => r.unmount());
    },
  );
  it("preserves configured inputs across unrelated edits and background refresh, then resets on a committed reopen", async () => {
    const r = await mount();
    await changeName(r, "My draft");
    await act(async () => {
      r.update(
        <TaskDialog
          {...props({ ...task, name: "Remote", externalInputs: [] })}
        />,
      );
    });
    await submit(r);
    expect(mocked.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "My draft", externalInputs: [input] }),
    );
    await act(async () => {
      r.update(<TaskDialog {...props(task, false)} />);
    });
    await act(async () => {
      r.update(
        <TaskDialog
          {...props({ ...task, name: "Latest", externalInputs: [] })}
        />,
      );
    });
    await submit(r);
    expect(mocked.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Latest", externalInputs: [] }),
    );
    await act(async () => r.unmount());
  });
  it("submits explicit removal and blocks invalid JSON and duplicate input names before mutation", async () => {
    const r = await mount();
    const editor = r.root.findByType(ExternalInputsEditor);
    const change = editor.props.onChange as (inputs: ExternalInput[]) => void;
    await act(async () => change([input, { ...input, name: "COUNTS" }]));
    await submit(r);
    expect(mocked.mutate).not.toHaveBeenCalled();
    await act(async () => change([]));
    await submit(r, false);
    expect(mocked.mutate).not.toHaveBeenCalled();
    await submit(r);
    expect(mocked.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ externalInputs: [] }),
    );
    await act(async () => r.unmount());
  });
  it("keeps legacy no-input tasks editable when external MCP is unconfigured", async () => {
    const r = await mount({ ...task, externalInputs: [] });
    await changeName(r, "Legacy renamed");
    await submit(r);
    expect(mocked.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Legacy renamed", externalInputs: [] }),
    );
    await act(async () => r.unmount());
  });
  it("disables fields while saving and pins external service validation errors", async () => {
    mocked.pending = true;
    const r = await mount();
    expect(r.root.findAllByType("fieldset")[0]!.props.disabled).toBe(true);
    await act(async () =>
      mocked.options?.onError({
        data: { field: "externalInputs" },
        message: "Choose an automatic tool",
      }),
    );
    expect(
      r.root
        .findAllByProps({ role: "alert" })
        .some((node) => node.children.includes("Choose an automatic tool")),
    ).toBe(true);
    await act(async () => r.unmount());
  });
});
