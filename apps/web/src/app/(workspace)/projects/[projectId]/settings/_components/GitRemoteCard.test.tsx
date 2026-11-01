import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const methods = [
    "save",
    "uploadKey",
    "deleteKey",
    "remove",
    "pushNow",
    "pull",
  ];
  const state: {
    data: unknown;
    error: unknown;
    queryOptions: unknown;
    options: Record<
      string,
      {
        onSuccess?: (data: never, variables: { projectId: string }) => void;
        onError?: (error: never) => void;
      }
    >;
  } = { data: null, error: null, queryOptions: undefined, options: {} };
  return {
    ...state,
    pending: false,
    mutations: Object.fromEntries(methods.map((name) => [name, vi.fn()])),
    reset: vi.fn(),
    invalidate: vi.fn(),
    setData: vi.fn(),
    toastError: vi.fn(),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocked.toastError },
}));
// Radix Dialog's Portal renders nothing without a DOM `document` (the
// vitest environment here is "node"); render content directly instead.
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      projectGitRemote: {
        get: { invalidate: mocked.invalidate, setData: mocked.setData },
      },
    }),
    projectGitRemote: {
      get: {
        useQuery: (_input: unknown, options: unknown) => {
          mocked.queryOptions = options;
          return {
            data: mocked.data,
            error: mocked.error,
            isLoading: false,
            refetch: vi.fn(),
          };
        },
      },
      ...Object.fromEntries(
        Object.keys(mocked.mutations).map((name) => [
          name,
          {
            useMutation: (options: (typeof mocked.options)[string]) => {
              mocked.options[name] = options;
              return {
                mutate: mocked.mutations[name],
                isPending: mocked.pending,
                reset: mocked.reset,
              };
            },
          },
        ]),
      ),
    },
  },
}));
import { GitRemoteCard } from "./GitRemoteCard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const projectId = "11111111-1111-1111-1111-111111111111";
const base = {
  projectId,
  remoteUrl: "git@example.test:team/project.git",
  branch: "main",
  enabled: false,
  revision: 1,
  key: null,
  hostKeyFingerprints: [],
  lastPushedSha: null,
  lastPushedAt: null,
  lastAttemptAt: null,
  lastErrorCode: null,
  failureCount: 0,
  nextAttemptAt: null,
  queued: false,
  pushing: false,
  pullQueued: false,
  pulling: false,
  lastPullSha: null,
  lastPullAt: null,
  lastPullErrorCode: null,
};
const withKey = {
  ...base,
  key: {
    name: "Deployment key",
    fingerprint: "SHA256:abc123",
    uploadedAt: "2026-09-18T00:00:00.000Z",
  },
};
type NodeMock = {
  name: string;
  type: string;
  value: string;
  checked: boolean;
  focus: ReturnType<typeof vi.fn>;
};
const nodes = new Map<string, NodeMock>();
const renderers: ReactTestRenderer[] = [];
async function mount() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<GitRemoteCard projectId={projectId} />, {
      createNodeMock: (element) => {
        if (element.type !== "input") return {};
        const props = element.props as {
          name?: string;
          type?: string;
          id?: string;
        };
        const node = {
          name: props.name ?? props.id ?? "",
          type: props.type ?? "text",
          value: "",
          checked: false,
          focus: vi.fn(),
        };
        nodes.set(node.name, node);
        return node;
      },
    });
  });
  renderers.push(renderer);
  return renderer;
}
async function change(
  renderer: ReactTestRenderer,
  name: string,
  value: string,
) {
  const node = nodes.get(name)!;
  node.value = value;
  await act(async () => {
    await (
      renderer.root.findByProps({ name }).props.onChange as (
        e: unknown,
      ) => unknown
    )({ type: "change", target: node });
  });
}
async function submit(renderer: ReactTestRenderer, name: string) {
  await act(async () => {
    await (
      renderer.root.findByProps({ "aria-label": name }).props.onSubmit as (
        e: unknown,
      ) => unknown
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}
async function selectKey(
  renderer: ReactTestRenderer,
  file: { size: number; text: () => Promise<string> },
) {
  await act(async () => {
    (
      renderer.root.findByProps({ id: "git-remote-private-key" }).props
        .onChange as (e: unknown) => void
    )({ target: { files: [file] } });
  });
}
function findButton(renderer: ReactTestRenderer, text: string) {
  const match = renderer.root
    .findAllByType("button")
    .find(
      (node) =>
        node.children.filter((child) => typeof child === "string").join("") ===
        text,
    );
  if (!match) throw new Error(`No button found with text "${text}"`);
  return match;
}
async function click(renderer: ReactTestRenderer, text: string) {
  const onClick = findButton(renderer, text).props.onClick as (
    event: unknown,
  ) => unknown;
  await act(async () => {
    await onClick({ currentTarget: {} });
  });
}

describe("Git remote settings", () => {
  beforeEach(() => {
    mocked.data = base;
    mocked.error = null;
    mocked.pending = false;
    nodes.clear();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => {
      for (const renderer of renderers.splice(0)) renderer.unmount();
    });
  });

  it("creates a paused configuration with main as the default branch", async () => {
    mocked.data = null;
    const renderer = await mount();
    await change(renderer, "remoteUrl", base.remoteUrl);
    await submit(renderer, "Git remote configuration");
    expect(mocked.mutations.save).toHaveBeenCalledWith({
      projectId,
      remoteUrl: base.remoteUrl,
      branch: "main",
      enabled: false,
    });
  });

  it("keeps unsaved fields and their revision across status polling", async () => {
    const renderer = await mount();
    await change(renderer, "branch", "my-draft");
    mocked.data = { ...base, branch: "other-edit", revision: 2 };
    await act(async () => {
      renderer.update(<GitRemoteCard projectId={projectId} />);
    });
    await submit(renderer, "Git remote configuration");
    expect(mocked.mutations.save).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "my-draft", expectedRevision: 1 }),
    );
    expect(mocked.queryOptions).toEqual(
      expect.objectContaining({ refetchInterval: 5000 }),
    );
  });

  it("clears the accepted private key file and mutation variables after upload", async () => {
    const renderer = await mount();
    await change(renderer, "keyName", "Deployment key");
    const text = vi.fn().mockResolvedValue("synthetic-private-key");
    await selectKey(renderer, { size: 256, text });
    const fileNode = nodes.get("git-remote-private-key")!;
    fileNode.value = "private-key-file";
    await submit(renderer, "Git remote SSH key");
    expect(mocked.mutations.uploadKey).toHaveBeenCalledWith({
      projectId,
      expectedRevision: 1,
      keyName: "Deployment key",
      privateKey: "synthetic-private-key",
    });
    await act(async () => {
      mocked.options.uploadKey?.onSuccess?.(
        { ...base, revision: 2, enabled: true } as never,
        { projectId },
      );
    });
    expect(fileNode.value).toBe("");
    expect(mocked.reset).toHaveBeenCalled();
    mocked.mutations.uploadKey!.mockClear();
    await submit(renderer, "Git remote SSH key");
    expect(mocked.mutations.uploadKey).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "synthetic-private-key",
    );
  });

  it("rejects oversized files before reading their contents", async () => {
    const renderer = await mount();
    await change(renderer, "keyName", "Deployment key");
    const text = vi.fn().mockResolvedValue("secret");
    await selectKey(renderer, { size: 65537, text });
    await submit(renderer, "Git remote SSH key");
    expect(text).not.toHaveBeenCalled();
    expect(mocked.mutations.uploadKey).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("64 KiB");
  });

  it("prevents uploading a file whose read finishes after leaving settings", async () => {
    const renderer = await mount();
    await change(renderer, "keyName", "Deployment key");
    let finishRead!: (value: string) => void;
    const pendingRead = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    await selectKey(renderer, { size: 256, text: () => pendingRead });
    let submitting!: Promise<unknown>;
    await act(async () => {
      submitting = (
        renderer.root.findByProps({ "aria-label": "Git remote SSH key" }).props
          .onSubmit as (event: unknown) => Promise<unknown>
      )({ preventDefault: vi.fn(), persist: vi.fn() });
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      finishRead("late-private-key");
      await submitting;
    });
    expect(mocked.mutations.uploadKey).not.toHaveBeenCalled();
  });

  it("disables edits while a mutation is pending", async () => {
    mocked.pending = true;
    const renderer = await mount();
    expect(
      renderer.root
        .findAllByType("fieldset")
        .every((field) => field.props.disabled === true),
    ).toBe(true);
  });

  it("hides cached settings after loss of owner access", async () => {
    mocked.error = {
      data: { code: "FORBIDDEN" },
      message: "untrusted server detail",
    };
    const renderer = await mount();
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(base.remoteUrl);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      "untrusted server detail",
    );
  });

  it("explains unavailable credential encryption without exposing server details", async () => {
    const renderer = await mount();
    await act(async () => {
      mocked.options.uploadKey?.onError?.({
        data: { code: "PRECONDITION_FAILED" },
        message: "SECRET key ring detail",
      } as never);
    });
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain("encryption is unavailable");
    expect(markup).toContain("administrator");
    expect(markup).not.toContain("SECRET");
  });

  it("explains a queue outage in push status", async () => {
    mocked.data = { ...base, lastErrorCode: "QUEUE_UNAVAILABLE" };
    const renderer = await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "push queue is unavailable",
    );
  });

  it("uses controlled mutation error copy instead of server messages", async () => {
    await mount();
    await act(async () => {
      mocked.options.save?.onError?.({
        data: { code: "INTERNAL_SERVER_ERROR" },
        message: "SECRET stderr",
      } as never);
    });
    expect(mocked.toastError).toHaveBeenCalled();
    expect(mocked.toastError.mock.calls.flat().join(" ")).not.toContain(
      "SECRET",
    );
  });

  it("opens a pull confirmation from an enabled 'Pull existing content' button and confirms the mutation", async () => {
    mocked.data = withKey;
    const renderer = await mount();
    expect(findButton(renderer, "Pull existing content").props.disabled).toBe(
      false,
    );
    await click(renderer, "Pull existing content");
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain("Pull existing content");
    expect(markup).toContain("merged using shared history");
    expect(markup).toContain("Remote edits and deletions");
    expect(markup).toContain("conflicts are preserved as separate copies");
    expect(markup).toContain("Removed members remain in Git history");
    await click(renderer, "Pull and merge");
    expect(mocked.mutations.pull).toHaveBeenCalledWith({ projectId });
  });

  it("disables 'Pull existing content' without an SSH key", async () => {
    const renderer = await mount();
    expect(findButton(renderer, "Pull existing content").props.disabled).toBe(
      true,
    );
  });

  it("shows 'Pull queued' while a pull is queued", async () => {
    mocked.data = { ...withKey, pullQueued: true };
    const renderer = await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain("Pull queued");
  });

  it("shows 'Pulling…' while a pull is in progress", async () => {
    mocked.data = { ...withKey, pulling: true };
    const renderer = await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain("Pulling…");
  });

  it("explains a missing remote branch from the last pull error", async () => {
    mocked.data = { ...withKey, lastPullErrorCode: "REMOTE_BRANCH_MISSING" };
    const renderer = await mount();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "The remote branch does not exist yet. Push first or check the branch name.",
    );
  });

  it("uses pull wording for a timed-out pull", async () => {
    mocked.data = { ...withKey, lastPullErrorCode: "TIMEOUT" };
    const renderer = await mount();
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain("The pull timed out. Try again.");
    expect(markup).not.toContain("The push timed out.");
  });

  it("shows the last pull timestamp and commit in the status list", async () => {
    mocked.data = {
      ...withKey,
      lastPullAt: "2026-09-18T12:00:00.000Z",
      lastPullSha: "abc1234",
    };
    const renderer = await mount();
    const dl = renderer.root.findByType("dl");
    const labels = dl.children
      .map((child) =>
        typeof child === "string"
          ? null
          : child.children
              .filter((grandchild) => typeof grandchild === "string")
              .join(""),
      )
      .filter((label): label is string => label !== null);
    expect(labels).toContain("Last pull");
    expect(labels).toContain("Last pulled commit");
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain("2026-09-18 12:00:00 UTC");
    expect(markup).toContain("abc1234");
  });
});
