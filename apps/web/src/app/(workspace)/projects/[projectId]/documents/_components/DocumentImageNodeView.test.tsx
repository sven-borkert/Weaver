import type { ReactNode } from "react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  useEditorState: ({
    editor,
    selector,
  }: {
    editor: { isEditable: boolean } | null;
    selector: (value: { editor: { isEditable: boolean } | null }) => unknown;
  }) => selector({ editor }),
}));

import { DocumentEditingProvider } from "./DocumentEditingContext";
import {
  clampImageWidth,
  DocumentImageNodeView,
  DocumentImageProvider,
} from "./DocumentImageNodeView";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
  tree = undefined;
});

const imageNode = (src: string) =>
  ({
    attrs: {
      src,
      alt: "Architecture",
      title: "Service map",
      width: 400,
      height: 200,
    },
  }) as unknown as ReactNodeViewProps["node"];

describe("DocumentImageNodeView", () => {
  it("updates an unchanged relative image when its document moves folders", async () => {
    const node = imageNode("overview.assets/map.png");
    const render = (path: string) => (
      <DocumentImageProvider projectId="project" documentPath={path}>
        <DocumentImageNodeView node={node} />
      </DocumentImageProvider>
    );
    await act(() => {
      tree = create(render("guides/overview.md"));
    });
    expect(tree!.root.findByType("img").props.src).toContain(
      "/api/projects/project/files/guides/overview.assets/map.png",
    );
    await act(() => tree!.update(render("manuals/overview.md")));
    expect(tree!.root.findByType("img").props.src).toContain(
      "/api/projects/project/files/manuals/overview.assets/map.png",
    );
    expect(tree!.root.findByType("img").props).toMatchObject({
      "data-weaver-src": "overview.assets/map.png",
      alt: "Architecture",
      title: "Service map",
      width: 400,
    });
    expect(
      (tree!.root.findByType("img").props as { height?: unknown }).height,
    ).toBeUndefined();
  });

  it("renders only a validated width", async () => {
    for (const width of ["400", 8, 12.5, 9000]) {
      await act(() => {
        tree = create(
          <DocumentImageNodeView
            node={
              {
                attrs: { src: "a.png", width, height: 10 },
              } as unknown as ReactNodeViewProps["node"]
            }
          />,
        );
      });
      const props = tree!.root.findByType("img").props as Record<
        string,
        unknown
      >;
      expect(props.width).toBeUndefined();
      expect(props.height).toBeUndefined();
      await act(() => tree!.unmount());
    }
  });

  it("shows an unavailable fallback for external and invalid image URLs", async () => {
    const render = (src: string) => (
      <DocumentImageProvider projectId="project" documentPath="overview.md">
        <DocumentImageNodeView node={imageNode(src)} />
      </DocumentImageProvider>
    );
    await act(() => {
      tree = create(render("https://example.com/image.png"));
    });
    expect(tree!.root.findAllByType("img")).toHaveLength(0);
    expect(tree!.root.findByProps({ role: "img" }).children).toContain(
      "Image unavailable",
    );
    await act(() => tree!.update(render("javascript:alert(1)")));
    expect(tree!.root.findAllByType("img")).toHaveLength(0);
  });
});

describe("DocumentImageNodeView resizing", () => {
  const COLUMN = 720;
  const IMAGE = 400;

  type Options = {
    editable?: boolean;
    selected?: boolean;
    disabled?: boolean;
    width?: number | null;
  };

  async function mount(options: Options = {}) {
    const updateAttributes = vi.fn();
    const capture = { set: vi.fn(), release: vi.fn() };
    const element = (current: Options) => (
      <DocumentEditingProvider disabled={current.disabled ?? false}>
        <DocumentImageNodeView
          node={
            {
              attrs: {
                src: "a.png",
                alt: "A",
                title: null,
                width: current.width ?? null,
              },
            } as unknown as ReactNodeViewProps["node"]
          }
          selected={current.selected ?? true}
          editor={
            {
              isEditable: current.editable ?? true,
              isDestroyed: false,
            } as unknown as ReactNodeViewProps["editor"]
          }
          updateAttributes={updateAttributes}
        />
      </DocumentEditingProvider>
    );
    await act(() => {
      tree = create(element(options), {
        createNodeMock: (rendered) =>
          rendered.type === "img"
            ? {
                getBoundingClientRect: () => ({ width: IMAGE }),
                closest: () => ({ clientWidth: COLUMN }),
              }
            : {},
      });
    });
    const rerender = async (next: Options) => {
      await act(() => tree!.update(element(next)));
    };
    const pointer = (clientX: number) => ({
      clientX,
      pointerId: 7,
      button: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: {
        setPointerCapture: capture.set,
        releasePointerCapture: capture.release,
        hasPointerCapture: () => true,
      },
    });
    const handle = (side: "left" | "right") =>
      tree!.root.findByProps({ "data-resize-handle": side });
    const fire = async (
      side: "left" | "right",
      event:
        | "onPointerDown"
        | "onPointerMove"
        | "onPointerUp"
        | "onPointerCancel"
        | "onLostPointerCapture",
      clientX: number,
    ) => {
      await act(() =>
        (handle(side).props as Record<string, (e: unknown) => void>)[event]!(
          pointer(clientX),
        ),
      );
    };
    const style = () =>
      (tree!.root.findByType("img").props as { style?: { width?: number } })
        .style;
    const press = async (name: string) => {
      await act(() =>
        (
          tree!.root.findByProps({ "aria-label": name }).props as {
            onClick: () => void;
          }
        ).onClick(),
      );
    };
    return { updateAttributes, capture, fire, style, press, rerender };
  }

  const handles = () =>
    tree!.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        node.props["data-resize-handle"] !== undefined,
    );
  const controls = () =>
    tree!.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        node.props["aria-label"] === "Image size",
    );

  it("previews while dragging and commits the width once on release", async () => {
    const { updateAttributes, capture, fire, style } = await mount();
    await fire("right", "onPointerDown", 500);
    expect(capture.set).toHaveBeenCalledWith(7);
    await fire("right", "onPointerMove", 440);
    expect(style()).toMatchObject({ width: 340 });
    await fire("right", "onPointerMove", 380.4);
    expect(style()).toMatchObject({ width: 280 });
    expect(updateAttributes).not.toHaveBeenCalled();
    await fire("right", "onPointerUp", 380.4);
    expect(updateAttributes).toHaveBeenCalledTimes(1);
    expect(updateAttributes).toHaveBeenCalledWith({ width: 280 });
    expect(capture.release).toHaveBeenCalledWith(7);
    expect(style()?.width).toBeUndefined();
  });

  it("grows from the left handle when dragged outward", async () => {
    const { updateAttributes, fire } = await mount();
    await fire("left", "onPointerDown", 100);
    await fire("left", "onPointerMove", 40);
    await fire("left", "onPointerUp", 40);
    expect(updateAttributes).toHaveBeenCalledWith({ width: 460 });
  });

  it("clamps the drag between 48 pixels and the column width", async () => {
    const { updateAttributes, fire, style } = await mount();
    await fire("right", "onPointerDown", 500);
    await fire("right", "onPointerMove", -5000);
    expect(style()).toMatchObject({ width: 48 });
    await fire("right", "onPointerMove", 5000);
    expect(style()).toMatchObject({ width: COLUMN });
    await fire("right", "onPointerUp", 5000);
    expect(updateAttributes).toHaveBeenCalledWith({ width: COLUMN });
  });

  it("commits nothing for a press without movement or a cancelled drag", async () => {
    const { updateAttributes, fire, style } = await mount();
    await fire("right", "onPointerDown", 500);
    await fire("right", "onPointerUp", 500);
    await fire("right", "onPointerDown", 500);
    await fire("right", "onPointerMove", 300);
    await fire("right", "onPointerCancel", 300);
    expect(style()?.width).toBeUndefined();
    await fire("right", "onPointerMove", 200);
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it("drops the drag when the pointer capture is lost", async () => {
    const { updateAttributes, fire, style } = await mount();
    await fire("right", "onPointerDown", 500);
    await fire("right", "onPointerMove", 300);
    expect(style()).toMatchObject({ width: 200 });
    await fire("right", "onLostPointerCapture", 300);
    expect(style()?.width).toBeUndefined();
    await fire("right", "onPointerMove", 250);
    await fire("right", "onPointerUp", 250);
    expect(style()?.width).toBeUndefined();
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it.each([
    ["the selection moves away", { selected: false }],
    ["the editor becomes read-only", { editable: false }],
    ["editing is disabled", { disabled: true }],
  ])("forgets a drag in progress when %s", async (_name, interrupted) => {
    const { updateAttributes, fire, style, rerender } = await mount();
    await fire("right", "onPointerDown", 500);
    await fire("right", "onPointerMove", 300);
    await rerender(interrupted);
    expect(style()?.width).toBeUndefined();
    await rerender({});
    expect(style()?.width).toBeUndefined();
    await fire("right", "onPointerMove", 250);
    await fire("right", "onPointerUp", 250);
    expect(style()?.width).toBeUndefined();
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it("offers column presets and a reset that removes the width", async () => {
    const { updateAttributes, press } = await mount({ width: 300 });
    await press("Set image width to 25%");
    await press("Set image width to 50%");
    await press("Set image width to 75%");
    await press("Set image width to 100%");
    await press("Reset image size");
    expect(updateAttributes.mock.calls).toEqual([
      [{ width: 180 }],
      [{ width: 360 }],
      [{ width: 540 }],
      [{ width: 720 }],
      [{ width: null }],
    ]);
  });

  it("disables the reset for an image without a width", async () => {
    await mount({ width: null });
    expect(
      tree!.root.findByProps({ "aria-label": "Reset image size" }).props
        .disabled,
    ).toBe(true);
  });

  it("shows the resize UI only for a selected image", async () => {
    await mount({ selected: false });
    expect(handles()).toHaveLength(0);
    expect(controls()).toHaveLength(0);
  });

  it.each([
    ["a read-only editor", { editable: false }],
    ["disabled editing", { disabled: true }],
  ])("shows no resize UI in %s", async (_name, options) => {
    await mount(options);
    expect(handles()).toHaveLength(0);
    expect(controls()).toHaveLength(0);
  });

  it("has two handles and a labelled control group when editable", async () => {
    await mount();
    expect(
      handles().map((node) => node.props["data-resize-handle"] as string),
    ).toEqual(["left", "right"]);
    expect(controls()).toHaveLength(1);
  });
});

describe("clampImageWidth", () => {
  it("rounds to whole pixels within the visual minimum and the column", () => {
    expect(clampImageWidth(199.6, 720)).toBe(200);
    expect(clampImageWidth(10, 720)).toBe(48);
    expect(clampImageWidth(900, 720)).toBe(720);
    expect(clampImageWidth(9000, 6000)).toBe(4096);
    expect(clampImageWidth(30, 20)).toBe(48);
  });
});
