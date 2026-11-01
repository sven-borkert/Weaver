import { useEffect, type ComponentProps, type ReactNode } from "react";
import type * as ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Renderer units check target reuse; browser coverage checks actual portals.
const portal = vi.hoisted(() => vi.fn<(target: HTMLElement) => void>());
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactDOM>()),
  createPortal: (children: ReactNode, target: HTMLElement) => {
    portal(target);
    return children;
  },
}));

import {
  DocumentsWorkspace,
  DocumentWorkspaceToolbar,
} from "./DocumentsWorkspace";

type Props = ComponentProps<typeof DocumentsWorkspace>;
let tree: ReactTestRenderer | undefined;

function environment(desktop = true) {
  const listeners = new Set<() => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const document = { activeElement: null as unknown };
  let frameId = 0;
  const query = {
    matches: desktop,
    addEventListener: vi.fn((_type: string, callback: () => void) => {
      listeners.add(callback);
    }),
    removeEventListener: vi.fn((_type: string, callback: () => void) => {
      listeners.delete(callback);
    }),
  };
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => query),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  vi.stubGlobal("document", document);
  return {
    query,
    async flushFrames() {
      await act(async () => {
        for (const [id, callback] of frames) {
          frames.delete(id);
          callback(0);
        }
      });
    },
    async resize(nextDesktop: boolean) {
      await act(async () => {
        query.matches = nextDesktop;
        for (const listener of listeners) listener();
      });
    },
    node() {
      const node = {
        contains: (element: unknown) => element === node,
        focus: vi.fn(() => {
          document.activeElement = node;
        }),
      };
      return node;
    },
  };
}

async function mountWorkspace(overrides: Partial<Props> = {}) {
  const surface = environment();
  const slots: object[] = [];
  let props: Props = {
    contextRail: <aside>Context details</aside>,
    children: <p>Document body</p>,
    ...overrides,
  };
  await act(async () => {
    tree = create(<DocumentsWorkspace {...props} />, {
      createNodeMock: (element) => {
        const node = surface.node();
        const attributes = element.props as Record<string, unknown>;
        if ("data-document-toolbar-slot" in attributes) slots.push(node);
        return node;
      },
    });
  });
  await surface.flushFrames();
  return {
    surface,
    slots,
    async rerender(next: Partial<Props>) {
      props = { ...props, ...next };
      await act(async () => {
        tree!.update(<DocumentsWorkspace {...props} />);
      });
    },
  };
}

function button(label: string) {
  return tree!.root.find(
    (node) => node.type === "button" && node.props["aria-label"] === label,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  portal.mockClear();
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
});

describe("document workspace header", () => {
  it("renders the persistent page header before the separately scrolling canvas", () => {
    const html = renderToStaticMarkup(
      <DocumentsWorkspace contextRail={<aside>Context details</aside>}>
        <p>Document body</p>
      </DocumentsWorkspace>,
    );
    expect(html).toContain('aria-label="Document page header"');
    expect(html.indexOf('aria-label="Document page header"')).toBeLessThan(
      html.indexOf('aria-label="Document workspace"'),
    );
  });

  it("keeps the toolbar and context controls outside the document scroll region", async () => {
    await mountWorkspace();
    const header = tree!.root.findByProps({
      "aria-label": "Document page header",
    });
    const canvas = tree!.root.findByProps({
      "aria-label": "Document workspace",
    });
    expect(header.type).toBe("header");
    expect(canvas.props.className).toContain("overflow-y-auto");
    expect(
      canvas.findAllByProps({ "aria-label": "Document page header" }),
    ).toEqual([]);
    expect(
      header.find((node) => "data-document-toolbar-slot" in node.props),
    ).toBeDefined();
    expect(
      header.findByProps({ "aria-label": "Document context controls" }),
    ).toBeDefined();
  });

  it("requests collapse and expansion from the header using the current callback", async () => {
    const collapse = vi.fn();
    const mounted = await mountWorkspace({
      contextRailCollapsed: false,
      onContextRailCollapsedChange: collapse,
    });
    expect(button("Collapse document context").props["aria-expanded"]).toBe(
      true,
    );
    const controlsId = button("Collapse document context").props[
      "aria-controls"
    ] as string;
    expect(
      tree!.root.findByProps({ id: controlsId }).findByType("aside").children,
    ).toEqual(["Context details"]);
    await act(async () => {
      const { onClick } = button("Collapse document context").props as {
        onClick: () => void;
      };
      onClick();
    });
    expect(collapse).toHaveBeenCalledExactlyOnceWith(true);
    const expand = vi.fn();
    await mounted.rerender({
      contextRailCollapsed: true,
      onContextRailCollapsedChange: expand,
    });
    expect(button("Expand document context").props["aria-expanded"]).toBe(
      false,
    );
    expect(button("Expand document context").props["aria-controls"]).toBe(
      controlsId,
    );
    await act(async () => {
      const { onClick } = button("Expand document context").props as {
        onClick: () => void;
      };
      onClick();
    });
    expect(expand).toHaveBeenCalledExactlyOnceWith(false);
    expect(collapse).toHaveBeenCalledOnce();
  });

  it("reuses the mounted toolbar target across collapse and breakpoint changes", async () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    function ToolbarProbe() {
      useEffect(() => {
        mount();
        return unmount;
      }, []);
      return <button type="button">Toolbar action</button>;
    }
    const mounted = await mountWorkspace({
      children: (
        <article>
          <DocumentWorkspaceToolbar>
            <ToolbarProbe />
          </DocumentWorkspaceToolbar>
          Document body
        </article>
      ),
    });
    const header = tree!.root.findByProps({
      "aria-label": "Document page header",
    });
    expect(mounted.slots).toHaveLength(1);
    expect(portal).toHaveBeenCalledWith(mounted.slots[0]);
    await mounted.rerender({ contextRailCollapsed: true });
    await mounted.surface.resize(false);
    await mounted.rerender({ contextRailCollapsed: false });
    await mounted.surface.resize(true);
    expect(
      tree!.root.findByProps({ "aria-label": "Document page header" }),
    ).toBe(header);
    expect(mounted.slots).toHaveLength(1);
    expect(new Set(portal.mock.calls.map(([target]) => target))).toEqual(
      new Set([mounted.slots[0]]),
    );
    expect(mount).toHaveBeenCalledOnce();
    expect(unmount).not.toHaveBeenCalled();
  });

  it("removes the responsive listener when the workspace unmounts", async () => {
    const { surface } = await mountWorkspace();
    expect(surface.query.addEventListener).toHaveBeenCalledOnce();
    await act(async () => tree!.unmount());
    tree = undefined;
    expect(surface.query.removeEventListener).toHaveBeenCalledWith(
      "change",
      surface.query.addEventListener.mock.calls[0]?.[1],
    );
  });
});
