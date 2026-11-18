import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDocumentDialog } from "./CreateDocumentDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";

const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  createFolder: vi.fn(),
  createLocal: vi.fn(),
  onFolderCreated: vi.fn(),
  push: vi.fn(),
  setLocalDetail: vi.fn(),
  setLocalList:
    vi.fn<
      (
        input: { projectId: string },
        update: (
          entries: { id: string }[] | undefined,
        ) => { id: string }[] | undefined,
      ) => void
    >(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/ui/dialog", () => {
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogTrigger: Container,
  };
});
vi.mock("~/trpc/react", () => {
  const query = { invalidate: vi.fn() };
  function createProcedure<T>(
    recordCall: (input: unknown) => void,
    response: T,
  ) {
    return {
      useMutation: ({ onSuccess }: { onSuccess: (data: T) => void }) => ({
        isPending: false,
        reset: vi.fn(),
        mutate: (input: unknown) => {
          recordCall(input);
          onSuccess(response);
        },
      }),
    };
  }
  return {
    api: {
      useUtils: () => ({
        document: { list: query },
        folder: { tree: query },
        localDocument: {
          list: { ...query, setData: mocks.setLocalList },
          get: { setData: mocks.setLocalDetail },
        },
      }),
      document: {
        create: createProcedure(mocks.createDocument, {
          id: "tracked-document",
        }),
      },
      folder: {
        create: createProcedure(mocks.createFolder, {
          path: ["guides", "draft"],
        }),
      },
      localDocument: {
        create: createProcedure(mocks.createLocal, { id: "local-entry" }),
      },
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type InputNode = {
  name: string;
  type: string;
  value: string;
  checked: boolean;
};

let renderer: ReactTestRenderer;
const inputs = new Map<string, InputNode>();

async function submit(kind: "document" | "folder", keepOutOfGit = false) {
  await act(async () => {
    renderer = create(
      kind === "document" ? (
        <CreateDocumentDialog projectId="p1" folderPath={["guides"]} />
      ) : (
        <CreateFolderDialog
          projectId="p1"
          parentPath={["guides"]}
          onFolderCreated={mocks.onFolderCreated}
        />
      ),
      {
        createNodeMock: ({ type, props }) => {
          if (type !== "input") return null;
          const input = props as { name: string; type?: string };
          const node = {
            name: input.name,
            type: input.type ?? "text",
            value: "",
            checked: false,
          };
          inputs.set(node.name, node);
          return node;
        },
      },
    );
  });

  async function changeInput(
    name: string,
    value: { value: string } | { checked: boolean },
  ) {
    const node = inputs.get(name)!;
    Object.assign(node, value);
    const input = renderer.root
      .findAllByType("input")
      .find(({ props }) => props.name === name)!;
    const onChange = input.props.onChange as (event: {
      type: "change";
      target: InputNode;
    }) => Promise<void>;
    await act(async () => onChange({ type: "change", target: node }));
  }

  await changeInput(kind === "document" ? "title" : "name", { value: "Draft" });
  if (keepOutOfGit) await changeInput("keepOutOfGit", { checked: true });

  const onSubmit = renderer.root.findByType("form").props.onSubmit as (event: {
    preventDefault: () => void;
    persist: () => void;
  }) => Promise<void>;
  await act(async () =>
    onSubmit({ preventDefault: vi.fn(), persist: vi.fn() }),
  );
}

beforeEach(() => {
  inputs.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => renderer.unmount());
});

describe("document and folder creation storage", () => {
  it("creates documents in the tracked folder by default", async () => {
    await submit("document");

    expect(mocks.createDocument).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      folderPath: ["guides"],
      title: "Draft",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    });
    expect(mocks.createLocal).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
      "/projects/p1/documents/tracked-document",
    );
  });

  it("creates folders at the tracked parent by default", async () => {
    await submit("folder");

    expect(mocks.createFolder).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      parentPath: ["guides"],
      name: "Draft",
    });
    expect(mocks.createLocal).not.toHaveBeenCalled();
    expect(mocks.onFolderCreated).toHaveBeenCalledExactlyOnceWith([
      "guides",
      "draft",
    ]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each(["document", "folder"] as const)(
    "opens a new %s in Outside Git when checked",
    async (kind) => {
      await submit(kind, true);

      expect(mocks.createLocal).toHaveBeenCalledExactlyOnceWith({
        projectId: "p1",
        kind,
        title: "Draft",
      });
      expect(mocks.createDocument).not.toHaveBeenCalled();
      expect(mocks.createFolder).not.toHaveBeenCalled();
      expect(mocks.onFolderCreated).not.toHaveBeenCalled();
      if (kind === "folder") {
        expect(mocks.setLocalList).toHaveBeenCalledExactlyOnceWith(
          { projectId: "p1" },
          expect.any(Function),
        );
        const updateList = mocks.setLocalList.mock.calls[0]![1];
        expect(updateList([{ id: "other-entry" }])).toEqual([
          { id: "other-entry" },
          { id: "local-entry" },
        ]);
        expect(mocks.setLocalList).toHaveBeenCalledBefore(mocks.push);
      } else {
        expect(mocks.setLocalDetail).toHaveBeenCalledExactlyOnceWith(
          { projectId: "p1", entryId: "local-entry" },
          { id: "local-entry" },
        );
        expect(mocks.setLocalDetail).toHaveBeenCalledBefore(mocks.push);
      }
      expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
        `/projects/p1/documents/local?${kind}=local-entry`,
      );
    },
  );
});
