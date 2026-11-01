import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => {
  const queryError: { value: unknown } = { value: null };
  return {
    data: {
      appearance: {
        backgroundColor: "#000000",
        icon: { type: "emoji", value: "📚" },
      },
      revision: "fresh-revision",
      canEdit: true,
    },
    hasData: true,
    queryError,
    isFetching: false,
    save: vi.fn(),
    invalidate: vi.fn(),
    close: vi.fn(),
    saved: vi.fn(),
  };
});
vi.mock("~/lib/basePath", () => ({
  withBasePath: (path: string) => `/weaver${path}`,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
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
    appearance: {
      get: {
        useQuery: () => ({
          data: mocked.hasData ? mocked.data : undefined,
          isFetching: mocked.isFetching,
          error: mocked.queryError.value,
          refetch: vi.fn(),
        }),
      },
      set: { useMutation: () => ({ mutateAsync: mocked.save }) },
    },
    useUtils: () => ({
      appearance: { get: { invalidate: mocked.invalidate } },
      folder: { tree: { invalidate: mocked.invalidate } },
      document: {
        list: { invalidate: mocked.invalidate },
        get: { invalidate: mocked.invalidate },
        history: { invalidate: mocked.invalidate },
      },
      tableFolder: { tree: { invalidate: mocked.invalidate } },
      table: {
        list: { invalidate: mocked.invalidate },
        get: { invalidate: mocked.invalidate },
        history: { invalidate: mocked.invalidate },
      },
    }),
  },
}));
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { AppearanceDialog } from "./AppearanceDialog";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = { projectId: "p1", kind: "document" as const, id: "d1" };
async function mount() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AppearanceDialog
        target={target}
        open
        onOpenChange={mocked.close}
        onSaved={mocked.saved}
      />,
    );
  });
  return renderer;
}
async function submit(renderer: ReactTestRenderer) {
  await act(async () => {
    await (
      renderer.root.findByType("form").props.onSubmit as (
        event: unknown,
      ) => Promise<void>
    )({ preventDefault: vi.fn(), persist: vi.fn() });
  });
}
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes(label))!;
}
describe("AppearanceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.hasData = true;
    mocked.queryError.value = null;
    mocked.isFetching = false;
    mocked.data = {
      appearance: {
        backgroundColor: "#000000",
        icon: { type: "emoji", value: "📚" },
      },
      revision: "fresh-revision",
      canEdit: true,
    };
    mocked.save.mockResolvedValue({ revision: "next" });
  });
  it("preview_and_save_preserve_untouched_fields", async () => {
    const renderer = await mount();
    await act(async () =>
      (button(renderer, "#ffffff").props.onClick as () => void)(),
    );
    expect(
      renderer.root.findByProps({ "aria-label": "Appearance preview" }).props
        .style,
    ).toMatchObject({ backgroundColor: "#ffffff", color: "#000000" });
    expect(JSON.stringify(renderer.toJSON())).toContain("📚");
    await submit(renderer);
    expect(mocked.save).toHaveBeenCalledWith({
      target,
      expectedRevision: "fresh-revision",
      patch: { backgroundColor: "#ffffff" },
    });
    expect(mocked.close).toHaveBeenCalledWith(false);
    await act(async () => renderer.unmount());
  });
  it("reset_restores_default_background", async () => {
    const renderer = await mount();
    await act(async () =>
      (button(renderer, "Reset background").props.onClick as () => void)(),
    );
    expect(
      renderer.root.findByProps({ "aria-label": "Appearance preview" }).props
        .style,
    ).toEqual({});
    await submit(renderer);
    expect(mocked.save).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { backgroundColor: null } }),
    );
    await act(async () => renderer.unmount());
  });
  it("reset_icon_preserves_background", async () => {
    const renderer = await mount();
    await act(async () => {
      (button(renderer, "Reset icon").props.onClick as () => void)();
    });
    expect(
      renderer.root.findByProps({ "aria-label": "Appearance preview" }).props
        .style,
    ).toMatchObject({ backgroundColor: "#000000", color: "#ffffff" });
    expect(
      renderer.root
        .findByProps({ "aria-label": "Appearance preview" })
        .findByType("svg").props["data-fallback"],
    ).toBe("file-text");
    await submit(renderer);
    expect(mocked.save).toHaveBeenCalledWith({
      target,
      expectedRevision: "fresh-revision",
      patch: { icon: null },
    });
    await act(async () => renderer.unmount());
  });
  it("preserves the background when choosing an icon", async () => {
    const renderer = await mount();
    await act(async () => {
      (
        renderer.root.findByProps({ "aria-label": "Use star icon" }).props
          .onClick as () => void
      )();
    });
    await submit(renderer);
    expect(mocked.save).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { icon: { type: "builtin", name: "star" } },
      }),
    );
    await act(async () => renderer.unmount());
  });
  it("uploads one multipart request with fetched revision and base path", async () => {
    const renderer = await mount();
    const upload = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", upload);
    const file = new File(["png"], "icon.png", { type: "image/png" });
    await act(async () => {
      (
        renderer.root.findByProps({ type: "file" }).props.onChange as (
          event: unknown,
        ) => void
      )({ target: { files: [file] } });
    });
    await submit(renderer);
    const [url, request] = upload.mock.calls[0] as [
      string,
      { method: string; body: FormData },
    ];
    expect(url).toBe("/weaver/api/projects/p1/appearance");
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body.get("target") as string)).toEqual(target);
    expect(request.body.get("expectedRevision")).toBe("fresh-revision");
    expect(request.body.get("patch")).toBe("{}");
    expect(request.body.get("file")).toBe(file);
    expect(mocked.save).not.toHaveBeenCalled();
    expect(mocked.close).toHaveBeenCalledWith(false);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
  it("disables save while fetching and preserves dirty fields across refresh", async () => {
    const renderer = await mount();
    await act(async () => {
      (button(renderer, "#ffffff").props.onClick as () => void)();
    });
    mocked.isFetching = true;
    await act(async () =>
      renderer.update(
        <AppearanceDialog
          target={target}
          open
          onOpenChange={mocked.close}
          onSaved={mocked.saved}
        />,
      ),
    );
    expect(button(renderer, "Save").props.disabled).toBe(true);
    await submit(renderer);
    expect(mocked.save).not.toHaveBeenCalled();
    mocked.isFetching = false;
    mocked.data = {
      ...mocked.data,
      revision: "refreshed-revision",
      appearance: {
        backgroundColor: "#223355",
        icon: { type: "emoji", value: "⭐" },
      },
    };
    await act(async () =>
      renderer.update(
        <AppearanceDialog
          target={target}
          open
          onOpenChange={mocked.close}
          onSaved={mocked.saved}
        />,
      ),
    );
    expect(
      renderer.root.findByProps({ "aria-label": "Appearance preview" }).props
        .style,
    ).toMatchObject({ backgroundColor: "#ffffff" });
    expect(JSON.stringify(renderer.toJSON())).toContain("⭐");
    await submit(renderer);
    expect(mocked.save).toHaveBeenCalledWith({
      target,
      expectedRevision: "refreshed-revision",
      patch: { backgroundColor: "#ffffff" },
    });
    await act(async () => renderer.unmount());
  });
  it("pins server errors and retains the dialog", async () => {
    const renderer = await mount();
    mocked.save.mockRejectedValue({
      message: "Invalid color",
      data: { field: "backgroundColor" },
    });
    await submit(renderer);
    expect(
      renderer.root.findByProps({ id: "appearance-color" }).props[
        "aria-invalid"
      ],
    ).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Invalid color");
    expect(mocked.close).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
  it("guards every close path and disables fields during save", async () => {
    let complete!: (value: unknown) => void;
    mocked.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const renderer = await mount();
    let request!: Promise<void>;
    await act(async () => {
      request = (
        renderer.root.findByType("form").props.onSubmit as (
          event: unknown,
        ) => Promise<void>
      )({ preventDefault: vi.fn(), persist: vi.fn() });
      await Promise.resolve();
    });
    expect(renderer.root.findByType(DialogContent).props["aria-busy"]).toBe(
      true,
    );
    expect(
      renderer.root
        .findAllByType("fieldset")
        .every((node) => node.props.disabled),
    ).toBe(true);
    await act(async () => {
      (
        renderer.root.findByType(Dialog).props.onOpenChange as (
          open: boolean,
        ) => void
      )(false);
    });
    expect(mocked.close).not.toHaveBeenCalled();
    await act(async () => {
      complete({ revision: "next" });
      await request;
    });
    expect(mocked.close).toHaveBeenCalledWith(false);
    await act(async () => renderer.unmount());
  });
  it("rejects an invalid image selection without saving a stale selection", async () => {
    const renderer = await mount();
    const upload = vi.fn();
    vi.stubGlobal("fetch", upload);
    const select = (file: File) =>
      (
        renderer.root.findByProps({ type: "file" }).props.onChange as (
          event: unknown,
        ) => void
      )({ target: { files: [file] } });
    await act(async () =>
      select(new File(["png"], "valid.png", { type: "image/png" })),
    );
    await act(async () =>
      select(
        new File(["exe"], "invalid.exe", { type: "application/octet-stream" }),
      ),
    );
    expect(button(renderer, "Save").props.disabled).toBe(true);
    await submit(renderer);
    expect(mocked.save).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await act(async () => {
      (button(renderer, "Reset icon").props.onClick as () => void)();
    });
    expect(button(renderer, "Save").props.disabled).toBe(false);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
  it("image_failure_keeps_dialog_open", async () => {
    const renderer = await mount();
    const file = new File(["bad"], "icon.png", { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Cannot upload image" }),
      }),
    );
    await act(async () =>
      (
        renderer.root.findByProps({ type: "file" }).props.onChange as (
          event: unknown,
        ) => void
      )({ target: { files: [file] } }),
    );
    await submit(renderer);
    expect(mocked.close).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("form")).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("Cannot upload image");
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe.each(["loading", "error", "loaded"] as const)(
  "AppearanceDialog %s close focus",
  (state) => {
    it.each([false, true])(
      "restores the connected target when trigger connected is %s",
      async (connected) => {
        mocked.hasData = state === "loaded";
        mocked.queryError.value =
          state === "error" ? new Error("load failed") : null;
        mocked.isFetching = state === "loading";
        const trigger = { isConnected: true, focus: vi.fn() };
        const fallback = { isConnected: true, focus: vi.fn() };
        const frames: (() => void)[] = [];
        vi.stubGlobal("document", {
          activeElement: trigger,
          querySelector: (selector: string) =>
            selector.startsWith("[data-appearance-trigger=")
              ? trigger
              : selector ===
                  "[data-explorer-focus], [data-table-workspace-focus], [data-document-title]"
                ? fallback
                : null,
        });
        vi.stubGlobal("window", {
          requestAnimationFrame: (callback: () => void) => {
            frames.push(callback);
            return frames.length;
          },
        });
        const renderer = await mount();
        trigger.isConnected = connected;
        const preventDefault = vi.fn();
        await act(async () => {
          (
            renderer.root.findByType(DialogContent).props
              .onCloseAutoFocus as (event: {
              preventDefault: () => void;
            }) => void
          )({ preventDefault });
        });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(trigger.focus).not.toHaveBeenCalled();
        expect(fallback.focus).not.toHaveBeenCalled();
        frames.splice(0).forEach((frame) => frame());
        expect(trigger.focus).toHaveBeenCalledTimes(connected ? 1 : 0);
        expect(fallback.focus).toHaveBeenCalledTimes(connected ? 0 : 1);
        await act(async () => renderer.unmount());
      },
    );
  },
);
