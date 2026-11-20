import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDocumentDialog } from "./CreateDocumentDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";

const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  createFolder: vi.fn(),
  onFolderCreated: vi.fn(),
  push: vi.fn(),
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
      useMutation: ({
        onSuccess,
      }: {
        onSuccess: (data: T, variables: unknown) => void;
      }) => ({
        isPending: false,
        reset: vi.fn(),
        mutate: (input: unknown) => {
          recordCall(input);
          onSuccess(response, input);
        },
      }),
    };
  }
  return {
    api: {
      useUtils: () => ({
        document: { list: query },
        folder: { tree: query },
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

async function submit(
  kind: "document" | "folder",
  keepOutOfGit = false,
  inUntrackedFolder = false,
) {
  await act(async () => {
    renderer = create(
      kind === "document" ? (
        <CreateDocumentDialog
          projectId="p1"
          folderPath={["guides"]}
          inUntrackedFolder={inUntrackedFolder}
        />
      ) : (
        <CreateFolderDialog
          projectId="p1"
          parentPath={["guides"]}
          onFolderCreated={mocks.onFolderCreated}
          inUntrackedFolder={inUntrackedFolder}
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
    expect(mocks.onFolderCreated).toHaveBeenCalledExactlyOnceWith([
      "guides",
      "draft",
    ]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps a checked document out of Git in the same folder", async () => {
    await submit("document", true);

    expect(mocks.createDocument).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      folderPath: ["guides"],
      title: "Draft",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
      untracked: true,
    });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
      "/projects/p1/documents/tracked-document",
    );
  });

  it("keeps a checked folder out of Git at the same level", async () => {
    await submit("folder", true);

    expect(mocks.createFolder).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      parentPath: ["guides"],
      name: "Draft",
      untracked: true,
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each(["document", "folder"] as const)(
    "creates a %s outside Git inside a folder that is outside Git",
    async (kind) => {
      await submit(kind, false, true);

      const call = (
        kind === "document" ? mocks.createDocument : mocks.createFolder
      ).mock.calls[0]![0] as { untracked?: boolean };
      expect(call.untracked).toBe(true);
      const forced = renderer.root
        .findAllByType("input")
        .find((input) => input.props.type === "checkbox")!;
      expect(forced.props).toMatchObject({ checked: true, disabled: true });
    },
  );
});
