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
    editor: { isEditable: boolean };
    selector: (value: { editor: { isEditable: boolean } }) => unknown;
  }) => selector({ editor }),
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { MathNodeView } from "./MathNodeView";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
});

function props(editable = true, source = "2 \\times 3", type = "inlineMath") {
  return {
    editor: { isEditable: editable, isDestroyed: false },
    node: { attrs: { source }, type: { name: type } },
    updateAttributes: vi.fn(),
  } as unknown as ReactNodeViewProps;
}

const formulaHtml = () =>
  tree!.root
    .findAll((node) => Boolean(node.props.dangerouslySetInnerHTML))
    .map((node) =>
      String((node.props.dangerouslySetInnerHTML as { __html: string }).__html),
    );

function click() {
  const button = tree!.root.findByProps({ "aria-label": "Edit formula" });
  (button.props as { onClick: () => void }).onClick();
}

describe("MathNodeView", () => {
  it("shows the rendered formula and edits its source after a click", async () => {
    const input = props();
    await act(() => {
      tree = create(<MathNodeView {...input} />);
    });
    expect(formulaHtml()[0]).toContain("×");
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);

    await act(() => click());
    const field = tree!.root.findByType("textarea");
    expect(field.props.value).toBe("2 \\times 3");
    await act(() =>
      (
        field.props as {
          onChange: (event: { target: { value: string } }) => void;
        }
      ).onChange({ target: { value: "x^2" } }),
    );
    expect(input.updateAttributes).toHaveBeenCalledWith({ source: "x^2" });
  });

  it("renders a block in display mode", async () => {
    const input = props(true, "x", "mathBlock");
    await act(() => {
      tree = create(<MathNodeView {...input} />);
    });
    expect(formulaHtml()[0]).toContain("katex-display");
  });

  it("offers no editing in a read-only editor", async () => {
    const input = props(false);
    await act(() => {
      tree = create(<MathNodeView {...input} />);
    });
    expect(formulaHtml()[0]).toContain("×");
    expect(tree!.root.findAllByType("button")).toHaveLength(0);
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("locks a visible source field when editability is revoked", async () => {
    const input = props();
    await act(() => {
      tree = create(<MathNodeView {...input} />);
    });
    await act(() => click());
    Object.defineProperty(input.editor, "isEditable", { value: false });
    await act(() => tree!.update(<MathNodeView {...input} />));
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
    expect(input.updateAttributes).not.toHaveBeenCalled();
  });

  it("makes an empty formula clickable", async () => {
    const input = props(true, "  ");
    await act(() => {
      tree = create(<MathNodeView {...input} />);
    });
    expect(
      tree!.root
        .findByProps({ "aria-label": "Edit formula" })
        .findAll((node) => node.children.includes("Empty formula")).length,
    ).toBeGreaterThan(0);
  });
});
