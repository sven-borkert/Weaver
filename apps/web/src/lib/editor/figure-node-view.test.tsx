import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stopFigureNodeViewEvent,
  textSelectedWithin,
  useFigureNodeView,
} from "./figure-node-view";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type FakeNode = { inside: boolean };
const inside: FakeNode = { inside: true };
const outside: FakeNode = { inside: false };
const root = { contains: (node: FakeNode) => node.inside };
type FakeSelection = {
  isCollapsed: boolean;
  anchorNode: FakeNode;
  focusNode: FakeNode;
};
const collapsed: FakeSelection = {
  isCollapsed: true,
  anchorNode: inside,
  focusNode: inside,
};
const textSelection: FakeSelection = { ...collapsed, isCollapsed: false };

/** A node inside a figure; `match` is what `closest` finds for field and control selectors. */
function target({
  match = null,
  selection = collapsed,
}: { match?: FakeNode | null; selection?: FakeSelection } = {}) {
  return {
    closest: (selector: string) =>
      selector === "[data-node-view-wrapper]" ? root : match,
    ownerDocument: { getSelection: () => selection },
  };
}

const event = (type: string, eventTarget: unknown = target()) =>
  ({ type, target: eventTarget, preventDefault: vi.fn() }) as unknown as Event;

describe("stopFigureNodeViewEvent", () => {
  it("keeps presses inside the view, blocks drags of its content and lets ProseMirror place drops", () => {
    expect(stopFigureNodeViewEvent({ event: event("mousedown") })).toBe(true);
    const drag = (eventTarget: unknown) => {
      const preventDefault = vi.fn();
      const stopped = stopFigureNodeViewEvent({
        event: {
          type: "dragstart",
          target: eventTarget,
          preventDefault,
        } as unknown as Event,
      });
      return { stopped, prevented: preventDefault.mock.calls.length > 0 };
    };
    expect(drag(target())).toEqual({ stopped: true, prevented: true });
    expect(drag(target({ match: inside }))).toEqual({
      stopped: true,
      prevented: false,
    });
    expect(stopFigureNodeViewEvent({ event: event("dragover") })).toBe(false);
    expect(stopFigureNodeViewEvent({ event: event("drop") })).toBe(false);
  });

  it("copies selected text natively and leaves node clipboard actions to ProseMirror", () => {
    const selected = target({ selection: textSelection });
    expect(stopFigureNodeViewEvent({ event: event("copy", selected) })).toBe(
      true,
    );
    expect(stopFigureNodeViewEvent({ event: event("cut", selected) })).toBe(
      true,
    );
    expect(stopFigureNodeViewEvent({ event: event("copy") })).toBe(false);
    expect(stopFigureNodeViewEvent({ event: event("paste") })).toBe(false);
    expect(
      stopFigureNodeViewEvent({
        event: event("paste", target({ match: inside })),
      }),
    ).toBe(true);
    // The editable editor around the view is no field of the view.
    expect(
      stopFigureNodeViewEvent({
        event: event("paste", target({ match: outside })),
      }),
    ).toBe(false);
    expect(
      textSelectedWithin(
        target({
          selection: { ...textSelection, focusNode: outside },
        }) as unknown as EventTarget,
      ),
    ).toBe(false);
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    figure: { group: "block", atom: true },
    text: {},
  },
});

function fakeEditor() {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("Intro")]),
    schema.node("figure"),
  ]);
  const editor = {
    isDestroyed: false,
    focused: false,
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
    }),
    view: {
      dom: { contains: (node: FakeNode) => node.inside },
      hasFocus: () => editor.focused,
      focus: vi.fn(() => {
        editor.focused = true;
      }),
      dispatch(transaction: Transaction) {
        editor.state = editor.state.apply(transaction);
      },
    },
  };
  return editor;
}

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
});

function Figure({
  editor,
  selected,
}: {
  editor: ReturnType<typeof fakeEditor>;
  selected: boolean;
}) {
  const { wrapperProps, frameProps } = useFigureNodeView({
    editor: editor as unknown as Editor,
    getPos: () => 7,
    selected,
  });
  return (
    <div data-node-view-wrapper="" {...wrapperProps}>
      <div {...frameProps}>
        <figcaption>Sigmoid</figcaption>
        <button type="button">Reset plot</button>
      </div>
    </div>
  );
}

function page(selection: FakeSelection) {
  let release: ((event: { target: FakeNode }) => void) | undefined;
  const pageSelection = {
    ...selection,
    anchorOffset: 1,
    focusOffset: 4,
    removeAllRanges: vi.fn(),
    setBaseAndExtent: vi.fn(),
  };
  const frame = {
    contains: (node: FakeNode) => node.inside,
    ownerDocument: {
      getSelection: () => pageSelection,
      defaultView: {
        addEventListener: (
          _type: string,
          listener: (event: { target: FakeNode }) => void,
        ) => {
          release = listener;
        },
      },
    },
  };
  return {
    frame,
    pageSelection,
    release: (target = inside) => release?.({ target }),
  };
}

describe("useFigureNodeView", () => {
  it("selects the node on a press, then refocuses and keeps the selected text visible", async () => {
    const editor = fakeEditor();
    await act(() => {
      tree = create(<Figure editor={editor} selected={false} />);
    });
    const frame = () => tree!.root.findByProps({ "data-figure-frame": "" });
    const press = async (
      button: number,
      selection: FakeSelection,
      match: FakeNode | null = null,
    ) => {
      const browser = page(selection);
      await act(() =>
        (
          frame().props as { onMouseDown: (event: unknown) => void }
        ).onMouseDown({
          button,
          shiftKey: false,
          target: target({ match }),
          currentTarget: browser.frame,
        }),
      );
      return browser;
    };

    await press(0, collapsed, inside);
    await press(2, collapsed);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);

    const drag = await press(0, textSelection);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(7);
    expect(drag.pageSelection.removeAllRanges).toHaveBeenCalledOnce();
    expect(frame().props["data-figure-text-selection"]).toBe("");
    await act(() => drag.release());
    expect(editor.view.focus).toHaveBeenCalledOnce();
    expect(drag.pageSelection.setBaseAndExtent).toHaveBeenCalledWith(
      inside,
      1,
      inside,
      4,
    );
    expect(frame().props["data-figure-text-selection"]).toBe("");

    await act(() => tree!.update(<Figure editor={editor} selected />));
    expect(frame().props["data-figure-text-selection"]).toBe("");
    await act(() => tree!.update(<Figure editor={editor} selected={false} />));
    expect(frame().props["data-figure-text-selection"]).toBeUndefined();

    // A plain click only selects the node, so none of its text is highlighted.
    const click = await press(0, collapsed);
    await act(() => click.release());
    expect(click.pageSelection.setBaseAndExtent).not.toHaveBeenCalled();
    expect(frame().props["data-figure-text-selection"]).toBeUndefined();

    // Releasing outside the editor leaves focus where it is.
    editor.focused = false;
    const away = await press(0, textSelection);
    await act(() => away.release(outside));
    expect(editor.view.focus).toHaveBeenCalledOnce();
    expect(away.pageSelection.setBaseAndExtent).not.toHaveBeenCalled();
  });

  it("copies when cutting selected figure text and ignores pastes into it", async () => {
    const editor = fakeEditor();
    await act(() => {
      tree = create(<Figure editor={editor} selected={false} />);
    });
    const wrapper = tree!.root.findByProps({ "data-node-view-wrapper": "" })
      .props as {
      onCut: (event: unknown) => void;
      onPaste: (event: unknown) => void;
    };
    const setData = vi.fn();
    const cut = {
      target: target({ selection: textSelection }),
      currentTarget: {
        ownerDocument: { getSelection: () => ({ toString: () => "Sigmoid" }) },
      },
      clipboardData: { setData },
      preventDefault: vi.fn(),
    };
    wrapper.onCut(cut);
    expect(setData).toHaveBeenCalledWith("text/plain", "Sigmoid");
    expect(cut.preventDefault).toHaveBeenCalled();
    const nodeCut = { target: target(), preventDefault: vi.fn() };
    wrapper.onCut(nodeCut);
    expect(nodeCut.preventDefault).not.toHaveBeenCalled();
    const paste = {
      target: target({ selection: textSelection }),
      preventDefault: vi.fn(),
    };
    wrapper.onPaste(paste);
    expect(paste.preventDefault).toHaveBeenCalled();
  });
});
