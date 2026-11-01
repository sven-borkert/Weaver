import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentViewShortcuts } from "./use-document-view-shortcuts";

class Target {
  isContentEditable = false;
  role: string | undefined;
  constructor(
    readonly tagName: string,
    readonly ownerDocument: Document,
    readonly parent: Target | null = null,
  ) {}
  contains(target: unknown): boolean {
    return (
      target === this ||
      (target instanceof Target &&
        target.parent !== null &&
        this.contains(target.parent))
    );
  }
  closest(selector: string): Target | null {
    if (
      selector.includes("role") &&
      this.role &&
      ["dialog", "alertdialog", "menu"].includes(this.role)
    )
      return this;
    if (
      selector.includes("input") &&
      ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName)
    )
      return this;
    return this.parent?.closest(selector) ?? null;
  }
}

function eventSurface() {
  const listeners = new Set<(event: KeyboardEvent) => void>();
  const addEventListener = vi.fn(
    (_type: string, callback: (event: KeyboardEvent) => void) => {
      listeners.add(callback);
    },
  );
  const removeEventListener = vi.fn(
    (_type: string, callback: (event: KeyboardEvent) => void) => {
      listeners.delete(callback);
    },
  );
  const owner = {
    defaultView: { HTMLElement: Target },
    addEventListener,
    removeEventListener,
  } as unknown as Document;
  return {
    owner,
    addEventListener,
    removeEventListener,
    send(event: KeyboardEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function keyEvent(target: unknown, overrides: Partial<KeyboardEvent> = {}) {
  const event = {
    key: "s",
    code: "KeyS",
    ctrlKey: true,
    metaKey: false,
    altKey: true,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    target,
    getModifierState: () => false,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
    ...overrides,
  };
  return event as unknown as KeyboardEvent;
}

type Props = Parameters<typeof useDocumentViewShortcuts>[0];
const cleanups: (() => void)[] = [];

async function mountShortcuts(overrides: Partial<Props> = {}) {
  const surface = eventSurface();
  const article = new Target("ARTICLE", surface.owner);
  const title = new Target("TEXTAREA", surface.owner, article);
  let props: Props = {
    articleRef: { current: article as unknown as HTMLElement },
    titleRef: { current: title as unknown as HTMLElement },
    onToggleSource: vi.fn(),
    ...overrides,
  };
  function Harness() {
    useDocumentViewShortcuts(props);
    return null;
  }
  let renderer!: ReactTestRenderer;
  let mounted = true;
  await act(async () => {
    renderer = create(<Harness />);
  });
  const unmount = async () => {
    await act(async () => {
      renderer.unmount();
      mounted = false;
    });
  };
  cleanups.push(() => {
    if (mounted) renderer.unmount();
  });
  return {
    surface,
    article,
    title,
    get props() {
      return props;
    },
    async send(target: unknown, overrides?: Partial<KeyboardEvent>) {
      const event = keyEvent(target, overrides);
      await act(async () => {
        surface.send(event);
      });
      return event;
    },
    async rerender(next: Partial<Props>) {
      props = { ...props, ...next };
      await act(async () => {
        renderer.update(<Harness />);
      });
    },
    unmount,
  };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.unstubAllGlobals();
});

describe("document view shortcut listener", () => {
  it("attaches to the article owner document in bubble phase and detaches on unmount", async () => {
    const mounted = await mountShortcuts();
    expect(mounted.surface.addEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
    const event = await mounted.send(mounted.article);
    expect(mounted.props.onToggleSource).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    await mounted.unmount();
    expect(mounted.surface.removeEventListener).toHaveBeenCalledWith(
      "keydown",
      mounted.surface.addEventListener.mock.calls[0]?.[1],
    );
    await mounted.send(mounted.article);
    expect(mounted.props.onToggleSource).toHaveBeenCalledOnce();
  });

  it("uses current callbacks and blocked state without reinstalling the listener", async () => {
    const mounted = await mountShortcuts({ blocked: true });
    expect((await mounted.send(mounted.article)).defaultPrevented).toBe(false);
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
    const source = vi.fn();
    await mounted.rerender({
      blocked: false,
      onToggleSource: source,
    });
    await mounted.send(mounted.article);
    const formerToolbarShortcut = await mounted.send(mounted.article, {
      key: "Dead",
      code: "KeyE",
      ctrlKey: false,
      metaKey: true,
    });
    expect(formerToolbarShortcut.defaultPrevented).toBe(false);
    expect(source).toHaveBeenCalledOnce();
    await mounted.rerender({ blocked: true });
    expect((await mounted.send(mounted.article)).defaultPrevented).toBe(false);
    expect(source).toHaveBeenCalledOnce();
    expect(mounted.surface.addEventListener).toHaveBeenCalledOnce();
  });

  it("allows title, document content, neutral body and buttons after blur", async () => {
    const mounted = await mountShortcuts();
    const paragraph = new Target("P", mounted.surface.owner, mounted.article);
    paragraph.isContentEditable = true;
    const button = new Target("BUTTON", mounted.surface.owner);
    for (const target of [
      mounted.title,
      paragraph,
      new Target("BODY", mounted.surface.owner),
      button,
      new Target("SPAN", mounted.surface.owner, button),
    ]) {
      expect((await mounted.send(target)).defaultPrevented).toBe(true);
    }
    expect(mounted.props.onToggleSource).toHaveBeenCalledTimes(5);
  });

  it("ignores unrelated form controls both inside and outside the article", async () => {
    const mounted = await mountShortcuts();
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      for (const parent of [null, mounted.article]) {
        const target = new Target(tag, mounted.surface.owner, parent);
        expect((await mounted.send(target)).defaultPrevented).toBe(false);
      }
    }
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
  });

  it("toggles raw mode from its fields without making Escape switch modes", async () => {
    const mounted = await mountShortcuts();
    const source = new Target(
      "SECTION",
      mounted.surface.owner,
      mounted.article,
    );
    const field = new Target("TEXTAREA", mounted.surface.owner, source);
    await mounted.rerender({
      sourceRef: { current: source as unknown as HTMLElement },
    });
    expect((await mounted.send(field)).defaultPrevented).toBe(true);
    const escape = {
      key: "Escape",
      code: "Escape",
      ctrlKey: false,
      altKey: false,
    };
    expect((await mounted.send(field, escape)).defaultPrevented).toBe(false);
    for (const flag of ["isComposing", "repeat"] as const) {
      expect(
        (await mounted.send(field, { ...escape, [flag]: true }))
          .defaultPrevented,
      ).toBe(false);
    }
    expect((await mounted.send(mounted.article, escape)).defaultPrevented).toBe(
      false,
    );
    const dialog = new Target("DIV", mounted.surface.owner, source);
    dialog.role = "dialog";
    expect((await mounted.send(dialog, escape)).defaultPrevented).toBe(false);
    expect(mounted.props.onToggleSource).toHaveBeenCalledOnce();
  });

  it("ignores dialog, alert dialog and menu descendants even when their controls are neutral", async () => {
    const mounted = await mountShortcuts();
    for (const role of ["dialog", "alertdialog", "menu"]) {
      const overlay = new Target("DIV", mounted.surface.owner);
      overlay.role = role;
      expect(
        (
          await mounted.send(
            new Target("BUTTON", mounted.surface.owner, overlay),
          )
        ).defaultPrevented,
      ).toBe(false);
    }
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
  });

  it("ignores editable surfaces outside the document and non-HTMLElement targets", async () => {
    const mounted = await mountShortcuts();
    const composerText = new Target("P", mounted.surface.owner);
    composerText.isContentEditable = true;
    for (const target of [composerText, null, {}, { tagName: "svg" }]) {
      expect((await mounted.send(target)).defaultPrevented).toBe(false);
    }
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
  });

  it("leaves save handling and the removed toolbar shortcut untouched", async () => {
    const mounted = await mountShortcuts();
    expect(
      (await mounted.send(mounted.article, { altKey: false })).defaultPrevented,
    ).toBe(false);
    expect(
      (await mounted.send(mounted.article, { key: "e", code: "KeyE" }))
        .defaultPrevented,
    ).toBe(false);
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
  });

  it.each(["isComposing", "defaultPrevented", "repeat"] as const)(
    "ignores %s without invoking a toggle",
    async (flag) => {
      const mounted = await mountShortcuts();
      const event = await mounted.send(mounted.article, { [flag]: true });
      expect(event.defaultPrevented).toBe(flag === "defaultPrevented");
      expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
    },
  );

  it("moves the listener when the article ref changes to another owner document", async () => {
    const mounted = await mountShortcuts();
    const next = eventSurface();
    const article = new Target("ARTICLE", next.owner);
    await mounted.rerender({
      articleRef: { current: article as unknown as HTMLElement },
    });
    expect(mounted.surface.removeEventListener).toHaveBeenCalledOnce();
    await mounted.send(mounted.article);
    expect(mounted.props.onToggleSource).not.toHaveBeenCalled();
    await act(async () => {
      next.send(keyEvent(article));
    });
    expect(mounted.props.onToggleSource).toHaveBeenCalledOnce();
  });
});
