import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { LocalDocumentsScreen } from "./LocalDocumentsScreen";

const query = vi.hoisted(() => ({
  failed: "",
  expired: false,
  lastRead: 1,
  refetch: vi.fn<() => Promise<{ isSuccess: boolean }>>(),
}));

vi.mock("~/trpc/react", () => {
  const result = <T,>(name: string, data: T) => ({
    data,
    error: name === query.failed ? { data: { code: "UNAUTHORIZED" } } : null,
    isSuccess: name !== query.failed,
    dataUpdatedAt: query.lastRead,
    refetch: query.refetch,
  });
  return {
    useSessionExpired: () => query.expired,
    api: {
      project: {
        get: { useQuery: () => result("project", { myRole: "Editor" }) },
      },
      localDocument: {
        list: { useQuery: () => result("list", []) },
        get: {
          useQuery: () =>
            result("detail", {
              id: "document",
              kind: "document",
              parentId: null,
              title: "Saved title",
              markdown: "Saved body",
            }),
        },
      },
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("./DocumentsWorkspace", () => ({
  DocumentsWorkspace: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("./LocalEntryDialog", () => ({ LocalEntryDialog: () => null }));
vi.mock("./LocalDocumentEditor", () => ({
  LocalDocumentEditor: ({
    entry,
    canEdit,
  }: {
    entry: { title: string; markdown: string };
    canEdit: boolean;
  }) => {
    const [title, setTitle] = useState(entry.title);
    const [body, setBody] = useState(entry.markdown);
    return (
      <>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button disabled={!canEdit}>Save</button>
      </>
    );
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  query.failed = "";
  query.expired = false;
  query.lastRead = 1;
  query.refetch.mockReset();
});

it.each(["project", "list", "detail"])(
  "keeps the draft while the %s query reports an expired session",
  async (name) => {
    const screen = () => (
      <LocalDocumentsScreen
        projectId="project"
        selection={{ document: "document" }}
      />
    );
    const root = () => renderer!.root;
    query.refetch.mockImplementation(async () => ({
      isSuccess: !query.failed,
    }));
    await act(async () => {
      renderer = create(screen());
    });
    await act(async () => {
      type DraftInputProps = {
        onChange: (event: { target: { value: string } }) => void;
      };
      const title = root().findByType("input").props as DraftInputProps;
      const body = root().findByType("textarea").props as DraftInputProps;
      title.onChange({ target: { value: "Dirty title" } });
      body.onChange({ target: { value: "Dirty body" } });
    });
    await act(async () => {
      query.failed = name;
      renderer!.update(screen());
    });
    expect(
      root()
        .findAllByType("button")
        .find((node) => node.props.children === "Save")?.props.disabled,
    ).toBe(true);
    expect(
      root()
        .findAllByType("div")
        .some((node) => node.props.inert),
    ).toBe(true);
    await act(async () => {
      query.expired = true;
      renderer!.update(screen());
    });
    await act(async () => {
      query.failed = "";
      query.expired = false;
      renderer!.update(screen());
    });
    expect(query.refetch).toHaveBeenCalled();
    expect(root().findByType("input").props.value).toBe("Dirty title");
    expect(root().findByType("textarea").props.value).toBe("Dirty body");
    expect(
      root()
        .findAllByType("button")
        .find((node) => node.props.children === "Save")?.props.disabled,
    ).toBe(false);
  },
);

it("restores editing when fresh queries confirm access without an auth transition", async () => {
  const screen = () => (
    <LocalDocumentsScreen
      projectId="project"
      selection={{ document: "document" }}
    />
  );
  query.refetch.mockResolvedValue({ isSuccess: false });
  await act(async () => {
    renderer = create(screen());
  });
  const button = () =>
    renderer!.root
      .findAllByType("button")
      .find((node) => node.props.children === "Save");
  await act(async () => {
    query.failed = "detail";
    renderer!.update(screen());
  });
  expect(button()?.props.disabled).toBe(true);
  expect(
    renderer!.root
      .findAllByType("a")
      .some((link) => link.props.target === "_blank"),
  ).toBe(true);
  await act(async () => {
    query.failed = "";
    query.lastRead += 1;
    renderer!.update(screen());
  });
  expect(button()?.props.disabled).toBe(false);
});
