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
vi.mock("./MermaidRenderer", () => ({
  MermaidRenderer: ({ source }: { source: string }) => (
    <svg aria-label={source} />
  ),
}));

import { MermaidNodeView } from "./MermaidNodeView";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
});

function props(editable = true) {
  return {
    editor: { isEditable: editable, isDestroyed: false },
    node: { attrs: { source: "flowchart TD\n A-->B" } },
    updateAttributes: vi.fn(),
  } as unknown as ReactNodeViewProps;
}

function click(label: string) {
  const button = tree!.root.findByProps({ "aria-label": label });
  (button.props as { onClick: () => void }).onClick();
}
function change(
  field: ReturnType<ReactTestRenderer["root"]["findByType"]>,
  value: string,
) {
  (
    field.props as { onChange: (event: { target: { value: string } }) => void }
  ).onChange({ target: { value } });
}

describe("MermaidNodeView", () => {
  it("starts as a diagram and edits source only after an explicit action", async () => {
    const input = props();
    await act(() => {
      tree = create(<MermaidNodeView {...input} />);
    });
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
    expect(tree!.root.findByType("svg").props["aria-label"]).toBe(
      "flowchart TD\n A-->B",
    );
    await act(() => click("Edit Mermaid source"));
    const field = tree!.root.findByType("textarea");
    await act(() => change(field, "flowchart LR\n A-->C"));
    expect(input.updateAttributes).toHaveBeenCalledWith({
      source: "flowchart LR\n A-->C",
    });
    await act(() => click("Close Mermaid source"));
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("locks a visible source field when editability is revoked", async () => {
    const input = props();
    await act(() => {
      tree = create(<MermaidNodeView {...input} />);
    });
    await act(() => click("Edit Mermaid source"));
    Object.defineProperty(input.editor, "isEditable", { value: false });
    await act(() => tree!.update(<MermaidNodeView {...input} />));
    const field = tree!.root.findByType("textarea");
    expect(field.props.disabled).toBe(true);
    await act(() => change(field, "late edit"));
    expect(input.updateAttributes).not.toHaveBeenCalled();
  });
});
