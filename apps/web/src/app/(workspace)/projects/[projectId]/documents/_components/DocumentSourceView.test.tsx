import { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSourceView } from "./DocumentSourceView";

let tree: ReactTestRenderer | undefined;
const resized: ResizeObserverCallback[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resized.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await act(() => tree?.unmount());
  vi.unstubAllGlobals();
});

const markdown =
  "## Draft heading\n\n**Unfinished Markdown\n\n```mermaid\nflowchart TD\n A --> B\n```\n";
function textarea() {
  const inputs = tree!.root.findAllByType("textarea");
  expect(inputs).toHaveLength(1);
  return inputs[0]!;
}

type SourceNode = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  setSelectionRange: ReturnType<typeof vi.fn>;
  ownerDocument: { activeElement: SourceNode | null };
  style: { height: string };
  scrollHeight: number;
  clientWidth: number;
  focus: ReturnType<typeof vi.fn>;
};

async function mountView() {
  const workspace = { scrollTop: 380, scrollLeft: 12 };
  const ownerDocument = { activeElement: null as SourceNode | null };
  const nodes: SourceNode[] = [];
  const inputRef = createRef<HTMLTextAreaElement>();
  let props = {
    value: markdown,
    readOnly: false,
    open: true,
    resetKey: 0,
    onChange: vi.fn(),
    inputRef,
  };
  await act(() => {
    tree = create(<DocumentSourceView {...props} />, {
      createNodeMock: (element) => {
        if (element.type !== "textarea") return {};
        let height = "";
        let text = props.value;
        const node = {
          scrollHeight: 220,
          clientWidth: 500,
          focus: vi.fn(),
          ownerDocument,
          selectionStart: text.length,
          selectionEnd: text.length,
          selectionDirection: "none" as SourceNode["selectionDirection"],
          get value() {
            return text;
          },
          set value(value: string) {
            text = value;
            node.selectionStart = node.selectionEnd = text.length;
            node.selectionDirection = "none";
          },
          setSelectionRange: vi.fn(
            (
              start: number,
              end: number,
              direction: SourceNode["selectionDirection"],
            ) => {
              node.selectionStart = start;
              node.selectionEnd = end;
              node.selectionDirection = direction;
            },
          ),
          style: {
            get height() {
              return height;
            },
            set height(value: string) {
              height = value;
              if (value === "auto") workspace.scrollTop = 0;
            },
          },
          closest: () => workspace,
        };
        nodes.push(node);
        return node;
      },
    });
  });
  return {
    inputRef,
    workspace,
    nodes,
    ownerDocument,
    get props() {
      return props;
    },
    async select(
      start: number,
      end = start,
      direction: SourceNode["selectionDirection"] = "none",
    ) {
      const node = inputRef.current as unknown as SourceNode;
      node.selectionStart = start;
      node.selectionEnd = end;
      node.selectionDirection = direction;
      const onSelect = textarea().props.onSelect as
        ((event: { currentTarget: SourceNode }) => void) | undefined;
      await act(() => onSelect?.({ currentTarget: node }));
    },
    async change(value: string, caret = value.length) {
      const node = inputRef.current as unknown as SourceNode;
      node.value = value;
      node.selectionStart = node.selectionEnd = caret;
      await act(() =>
        (
          textarea().props.onChange as (event: {
            target: SourceNode;
            currentTarget: SourceNode;
          }) => void
        )({ target: node, currentTarget: node }),
      );
    },
    async rerender(next: Partial<typeof props>) {
      props = { ...props, ...next };
      const node = inputRef.current as unknown as SourceNode | null;
      // Model React's native value assignment before component layout effects.
      if (node && node.value !== props.value) node.value = props.value;
      await act(() => tree!.update(<DocumentSourceView {...props} />));
    },
  };
}

function escapeEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "Escape",
    defaultPrevented: false,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    currentTarget: { blur: vi.fn() },
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("DocumentSourceView", () => {
  it("edits the exact raw Markdown without adding headings, comments, or action controls", async () => {
    const view = await mountView();
    const input = textarea();
    expect(input.props.value).toBe(markdown);
    expect(input.props.readOnly).toBe(false);
    expect(tree!.root.findAllByType("button")).toHaveLength(0);
    expect(tree!.root.findAllByType("h2")).toHaveLength(0);
    expect(tree!.root.findAllByProps({ role: "status" })).toHaveLength(0);
    expect(
      tree!.root.findByProps({
        role: "region",
        "aria-label": "Markdown source",
      }).props.tabIndex,
    ).toBe(-1);
    await view.change("**raw and unfinished");
    expect(view.props.onChange).toHaveBeenCalledWith("**raw and unfinished");
  });

  it("keeps read-only Markdown selectable while refusing editing callbacks", async () => {
    const view = await mountView();
    await view.rerender({ readOnly: true });
    const input = textarea();
    expect(input.props.readOnly).toBe(true);
    expect(input.props.disabled).not.toBe(true);
    await view.change("blocked");
    expect(view.props.onChange).not.toHaveBeenCalled();
    expect(input.props.value).toBe(markdown);
  });

  it("grows to the source height and resizes for changed width without moving workspace scroll", async () => {
    const view = await mountView();
    textarea();
    expect(view.nodes[0]?.style.height).toBe("220px");
    expect(view.workspace.scrollTop).toBe(380);
    const node = view.nodes[0]!;
    node.scrollHeight = 640;
    await view.rerender({ value: markdown + "More lines\n" });
    expect(node.style.height).toBe("640px");
    expect(view.workspace.scrollTop).toBe(380);
    node.scrollHeight = 820;
    node.clientWidth = 280;
    await act(() =>
      resized[0]?.(
        [{ contentRect: { width: 280 } }] as ResizeObserverEntry[],
        {} as ResizeObserver,
      ),
    );
    expect(node.style.height).toBe("820px");
    expect(view.workspace.scrollTop).toBe(380);
    expect(node.focus).not.toHaveBeenCalled();
  });

  it("retains the native textarea across mode toggles and ordinary edits but replaces it on reset", async () => {
    const view = await mountView();
    textarea();
    const original = view.inputRef.current;
    expect(original).not.toBeNull();
    await view.rerender({ value: "Changed" });
    expect(view.inputRef.current).toBe(original);
    await view.rerender({ open: false });
    expect(view.inputRef.current).toBe(original);
    expect(tree!.root.findByProps({ role: "region" }).props.hidden).toBe(true);
    expect(tree!.root.findByProps({ role: "region" }).props.inert).toBe(true);
    await view.rerender({ open: true });
    expect(view.inputRef.current).toBe(original);
    await view.rerender({ resetKey: 1, value: markdown });
    expect(view.inputRef.current).not.toBe(original);
    expect(textarea().props.value).toBe(markdown);
  });

  it.each([false, true])(
    "blurs Escape without changing source mode or text (readOnly=%s)",
    async (readOnly) => {
      const view = await mountView();
      await view.rerender({ readOnly });
      const input = textarea();
      expect(typeof input.props.onKeyDown).toBe("function");
      const event = escapeEvent();
      await act(() =>
        (
          input.props.onKeyDown as (
            event: ReturnType<typeof escapeEvent>,
          ) => void
        )(event),
      );
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.currentTarget.blur).toHaveBeenCalledOnce();
      expect(view.props.onChange).not.toHaveBeenCalled();
      expect(tree!.root.findByProps({ role: "region" }).props.hidden).toBe(
        false,
      );
      expect(textarea().props.value).toBe(markdown);
    },
  );

  it("leaves composed, handled, repeated and modified Escape events untouched", async () => {
    await mountView();
    const input = textarea();
    expect(typeof input.props.onKeyDown).toBe("function");
    for (const overrides of [
      { nativeEvent: { isComposing: true } },
      { defaultPrevented: true },
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { key: "s", ctrlKey: true, altKey: true },
    ]) {
      const event = escapeEvent(overrides);
      await act(() =>
        (
          input.props.onKeyDown as (
            event: ReturnType<typeof escapeEvent>,
          ) => void
        )(event),
      );
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.currentTarget.blur).not.toHaveBeenCalled();
    }
  });

  it("preserves a focused backward selection when Save canonicalizes raw Markdown", async () => {
    const view = await mountView();
    await view.rerender({ value: "__text__\n\n" });
    const node = view.nodes[0]!;
    view.ownerDocument.activeElement = node;
    await view.select(2, 6, "backward");
    await view.rerender({ value: "**text**\n" });
    expect(node.selectionStart).toBe(2);
    expect(node.selectionEnd).toBe(6);
    expect(node.selectionDirection).toBe("backward");
    expect(node.focus).not.toHaveBeenCalled();
  });

  it("clamps the focused selection after external source shortening", async () => {
    const view = await mountView();
    await view.rerender({ value: "__text__\n\n" });
    const node = view.nodes[0]!;
    view.ownerDocument.activeElement = node;
    await view.select(2, 10, "forward");
    await view.rerender({ value: "x\n" });
    expect(node.setSelectionRange).toHaveBeenCalledWith(2, 2, "forward");
    expect(node.selectionStart).toBe(2);
    expect(node.selectionEnd).toBe(2);
  });

  it("leaves native typing echoes and unfocused external updates alone", async () => {
    const view = await mountView();
    const node = view.nodes[0]!;
    view.ownerDocument.activeElement = node;
    await view.change("__typed__\n", 5);
    await view.rerender({ value: "__typed__\n" });
    expect(node.selectionStart).toBe(5);
    expect(node.setSelectionRange).not.toHaveBeenCalled();
    await view.select(2, 7, "backward");
    view.ownerDocument.activeElement = null;
    await view.rerender({ value: "**typed**\n" });
    expect(node.setSelectionRange).not.toHaveBeenCalled();
    expect(node.focus).not.toHaveBeenCalled();
  });
});
