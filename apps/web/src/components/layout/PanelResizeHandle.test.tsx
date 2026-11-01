import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PanelResizeHandle,
  PanelWidthsContext,
  type PanelWidthControls,
} from "./PanelResizeHandle";

function controls(): PanelWidthControls {
  return {
    widths: { sidebar: 278, contextRail: 300 },
    preview: vi.fn(),
    commit: vi.fn(),
  };
}

type HandleProps = {
  onPointerDown: (event: unknown) => void;
  onPointerMove: (event: unknown) => void;
  onPointerUp: (event: unknown) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: unknown) => void;
};

async function mount(value: PanelWidthControls) {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PanelWidthsContext.Provider value={value}>
        <PanelResizeHandle panel="contextRail" label="Resize context panel" />
      </PanelWidthsContext.Provider>,
    );
  });
  const handle = () =>
    renderer.root.findByProps({ role: "separator" }).props as HandleProps;
  return { renderer: renderer!, handle };
}

afterEach(() => vi.unstubAllGlobals());

describe("PanelResizeHandle", () => {
  it("renders an accessible vertical separator with the current width", () => {
    const html = renderToStaticMarkup(
      <PanelWidthsContext.Provider value={controls()}>
        <PanelResizeHandle panel="contextRail" label="Resize context panel" />
      </PanelWidthsContext.Provider>,
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize context panel"');
    expect(html).toContain('aria-valuenow="300"');
    expect(html).toContain('aria-valuemin="260"');
    expect(html).toContain('aria-valuemax="560"');
    expect(html).toContain('tabindex="0"');
  });

  it("renders nothing outside the shell", () => {
    expect(
      renderToStaticMarkup(
        <PanelResizeHandle panel="sidebar" label="Resize sidebar" />,
      ),
    ).toBe("");
  });

  it("previews while dragging and saves once on release", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("window", { innerWidth: 1440 });
    vi.stubGlobal("document", { documentElement: root });
    const value = controls();
    const { renderer, handle } = await mount(value);
    const target = {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
      parentElement: { getBoundingClientRect: () => ({ width: 300 }) },
    };
    const pointer = (clientX: number) => ({
      button: 0,
      clientX,
      pointerId: 7,
      currentTarget: target,
      preventDefault: vi.fn(),
    });

    await act(async () => handle().onPointerDown(pointer(900)));
    expect(target.setPointerCapture).toHaveBeenCalledWith(7);
    expect(root.dataset.panelResizing).toBe("true");
    await act(async () => handle().onPointerMove(pointer(860)));
    await act(async () => handle().onPointerMove(pointer(820)));
    expect(value.preview).toHaveBeenLastCalledWith("contextRail", 380);
    expect(value.commit).not.toHaveBeenCalled();
    await act(async () => handle().onPointerUp(pointer(820)));
    expect(value.commit).toHaveBeenCalledExactlyOnceWith("contextRail", 380);
    expect(root.dataset.panelResizing).toBeUndefined();
    await act(async () => renderer.unmount());
  });

  it("keeps the saved width when a press does not move", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { innerWidth: 1440 });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    const value = controls();
    const { renderer, handle } = await mount(value);
    const event = {
      button: 0,
      clientX: 900,
      pointerId: 1,
      preventDefault: vi.fn(),
      currentTarget: {
        setPointerCapture: vi.fn(),
        hasPointerCapture: () => true,
        releasePointerCapture: vi.fn(),
        parentElement: { getBoundingClientRect: () => ({ width: 300 }) },
      },
    };

    await act(async () => handle().onPointerDown(event));
    await act(async () => handle().onPointerUp(event));
    expect(value.commit).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("resets on double-click and steps with the arrow keys", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { innerWidth: 1440 });
    const value = controls();
    const { renderer, handle } = await mount(value);
    const key = (name: string) => ({ key: name, preventDefault: vi.fn() });

    await act(async () => handle().onDoubleClick());
    expect(value.commit).toHaveBeenLastCalledWith("contextRail", 320);
    const left = key("ArrowLeft");
    await act(async () => handle().onKeyDown(left));
    expect(value.commit).toHaveBeenLastCalledWith("contextRail", 316);
    expect(left.preventDefault).toHaveBeenCalled();
    const tab = key("Tab");
    await act(async () => handle().onKeyDown(tab));
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(value.commit).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });
});
