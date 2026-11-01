import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentSourceView } from "./use-document-source-view";

class Element {
  isConnected = true;
  scrollTop = 0;
  scrollLeft = 0;
  workspace: Element | null = null;
  focus = vi.fn((_options?: FocusOptions) => {
    this.ownerDocument.activeElement = this;
  });
  constructor(
    readonly ownerDocument: {
      activeElement: Element | null;
      defaultView: { HTMLElement: typeof Element };
    },
  ) {}
  closest(selector: string) {
    return selector === '[role="region"][aria-label="Document workspace"]'
      ? this.workspace
      : null;
  }
}

const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.unstubAllGlobals();
});

async function mountView() {
  const owner = {
    activeElement: null as Element | null,
    defaultView: { HTMLElement: Element },
  };
  const workspace = new Element(owner);
  workspace.scrollTop = 680;
  workspace.scrollLeft = 12;
  const article = new Element(owner);
  article.workspace = workspace;
  const previous = new Element(owner);
  owner.activeElement = previous;
  const input = new Element(owner);
  const source = new Element(owner);
  const articleRef = { current: article as unknown as HTMLElement };
  let navigationKey: string | undefined = "doc:intro:sha";
  let canShowFormatted = true;
  let result!: ReturnType<typeof useDocumentSourceView>;
  const renderedModes: boolean[] = [];
  function Harness() {
    result = useDocumentSourceView({
      articleRef,
      navigationKey,
      canShowFormatted,
    });
    renderedModes.push(result.sourceOpen);
    return result.sourceOpen ? (
      <section ref={result.sourceRef}>
        <textarea ref={result.sourceInputRef} />
      </section>
    ) : null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<Harness />, {
      createNodeMock: (element) =>
        element.type === "textarea" ? input : source,
    });
  });
  cleanups.push(() => renderer.unmount());
  return {
    workspace,
    article,
    previous,
    input,
    source,
    owner,
    renderedModes,
    get result() {
      return result;
    },
    async toggle(open: boolean) {
      await act(() => result.setSourceOpen(open));
    },
    async setCanShowFormatted(value: boolean) {
      canShowFormatted = value;
      await act(() => renderer.update(<Harness />));
    },
    async rerender(nextKey = navigationKey) {
      navigationKey = nextKey;
      await act(() => renderer.update(<Harness />));
    },
  };
}

describe("inline document source view", () => {
  it("focuses its noneditable source region only on open and restores the previous focus and workspace scroll on close", async () => {
    const view = await mountView();
    expect(view.source.focus).not.toHaveBeenCalled();
    expect(view.previous.focus).not.toHaveBeenCalled();
    expect(view.workspace.scrollTop).toBe(680);
    await view.toggle(true);
    expect(view.result.sourceOpen).toBe(true);
    expect(view.result.sourceRef.current).toBe(view.source);
    expect(view.result.sourceInputRef.current).toBe(view.input);
    expect(view.input.focus).not.toHaveBeenCalled();
    expect(view.owner.activeElement).toBe(view.source);
    expect(view.source.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(view.workspace.scrollTop).toBe(0);
    view.workspace.scrollTop = 35;
    view.workspace.scrollLeft = 2;
    await view.toggle(false);
    expect(view.result.sourceOpen).toBe(false);
    expect(view.owner.activeElement).toBe(view.previous);
    expect(view.previous.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(view.workspace.scrollTop).toBe(680);
    expect(view.workspace.scrollLeft).toBe(12);
  });

  it("does not refocus or move scroll when the open source rerenders", async () => {
    const view = await mountView();
    await view.toggle(true);
    view.workspace.scrollTop = 220;
    await view.rerender();
    await view.toggle(true);
    expect(view.source.focus).toHaveBeenCalledTimes(1);
    expect(view.workspace.scrollTop).toBe(220);
  });

  it("reveals formatted content in the first render of section navigation without restoring the old position", async () => {
    const view = await mountView();
    await view.toggle(true);
    view.previous.focus.mockClear();
    const navigationTarget = new Element(view.owner);
    navigationTarget.focus();
    view.workspace.scrollTop = 950;
    view.renderedModes.length = 0;
    await view.rerender("doc:requested-section:sha");
    expect(view.renderedModes[0]).toBe(false);
    expect(view.result.sourceOpen).toBe(false);
    expect(view.owner.activeElement).toBe(navigationTarget);
    expect(view.previous.focus).not.toHaveBeenCalled();
    expect(view.workspace.scrollTop).toBe(950);
    await view.rerender("doc:intro:sha");
    expect(view.result.sourceOpen).toBe(false);
  });

  it("captures a fresh position when reopening after navigation and falls back to the workspace if the old focus target disappeared", async () => {
    const view = await mountView();
    await view.toggle(true);
    await view.rerender("doc:next:sha");
    view.workspace.scrollTop = 910;
    view.owner.activeElement = view.previous;
    await view.toggle(true);
    view.previous.isConnected = false;
    await view.toggle(false);
    expect(view.owner.activeElement).toBe(view.workspace);
    expect(view.workspace.scrollTop).toBe(910);
  });

  it("keeps invalid raw text open during manual close and section navigation, then reveals the pending section once valid", async () => {
    const view = await mountView();
    await view.toggle(true);
    await view.setCanShowFormatted(false);
    await view.toggle(false);
    expect(view.result.sourceOpen).toBe(true);
    view.input.focus();
    view.workspace.scrollTop = 320;
    view.renderedModes.length = 0;
    await view.rerender("doc:requested:sha");
    expect(view.renderedModes[0]).toBe(true);
    expect(view.owner.activeElement).toBe(view.input);
    expect(view.workspace.scrollTop).toBe(320);
    view.renderedModes.length = 0;
    await view.setCanShowFormatted(true);
    expect(view.renderedModes[0]).toBe(false);
    expect(view.result.sourceOpen).toBe(false);
    expect(view.previous.focus).not.toHaveBeenCalled();
    expect(view.workspace.scrollTop).toBe(320);
  });
});
