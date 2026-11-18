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
vi.mock("~/lib/editor/MathPlot", () => ({
  MathPlot: ({ source }: { source: string }) => <div data-source={source} />,
}));

import { DocumentEditingProvider } from "./DocumentEditingContext";
import { MathPlotNodeView } from "./MathPlotNodeView";
import {
  DEFAULT_MATH_PLOT_SOURCE,
  MATH_PLOT_EXAMPLES,
} from "./math-plot-examples";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
});

function renderProps() {
  return {
    editor: { isEditable: true, isDestroyed: false },
    node: { attrs: { source: DEFAULT_MATH_PLOT_SOURCE } },
    updateAttributes: vi.fn(),
  } as unknown as ReactNodeViewProps;
}

function button(label: string) {
  return tree!.root
    .findAllByType("button")
    .find((item) => item.children.includes(label))!;
}

function click(label: string) {
  (button(label).props as { onClick: () => void }).onClick();
}

function change(value: string) {
  const field = tree!.root.findByType("textarea");
  (
    field.props as { onChange: (event: { target: { value: string } }) => void }
  ).onChange({ target: { value } });
}

describe("MathPlotNodeView", () => {
  it("previews editable examples and applies only a valid source", async () => {
    const props = renderProps();
    await act(() => {
      tree = create(<MathPlotNodeView {...props} />);
    });
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
    await act(() => click("Edit plot"));
    await act(() => change("{broken"));
    expect(button("Apply plot").props.disabled).toBe(true);
    await act(() => click("Apply plot"));
    expect(props.updateAttributes).not.toHaveBeenCalled();

    await act(() => click("Parametric"));
    const source = MATH_PLOT_EXAMPLES[1].source;
    expect(tree!.root.findByType("textarea").props.value).toBe(source);
    expect(tree!.root.findByProps({ "data-source": source })).toBeDefined();
    expect(props.updateAttributes).not.toHaveBeenCalled();
    await act(() => click("Apply plot"));
    expect(props.updateAttributes).toHaveBeenCalledOnce();
    expect(props.updateAttributes).toHaveBeenCalledWith({ source });
    expect(tree!.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("allows cancelling a source draft while document changes are locked", async () => {
    const props = renderProps();
    const view = (disabled: boolean) => (
      <DocumentEditingProvider disabled={disabled}>
        <MathPlotNodeView {...props} />
      </DocumentEditingProvider>
    );
    await act(() => {
      tree = create(view(false));
    });
    await act(() => click("Edit plot"));
    await act(() => click("3D surface"));
    expect(button("Apply plot").props.disabled).toBe(false);
    await act(() => tree!.update(view(true)));
    expect(tree!.root.findByType("textarea").props.disabled).toBe(true);
    expect(button("Apply plot").props.disabled).toBe(true);
    await act(() => click("Apply plot"));
    await act(() => click("Cancel"));
    expect(props.updateAttributes).not.toHaveBeenCalled();
    expect(
      tree!.root.findByProps({ "data-source": DEFAULT_MATH_PLOT_SOURCE }),
    ).toBeDefined();
  });
});
