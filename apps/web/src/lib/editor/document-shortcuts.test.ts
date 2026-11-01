import { describe, expect, it } from "vitest";
import {
  classifyDocumentShortcut,
  type DocumentShortcutContext,
  type DocumentShortcutEvent,
} from "./document-shortcuts";

function keyEvent(
  overrides: Partial<DocumentShortcutEvent> = {},
): DocumentShortcutEvent {
  return {
    key: "s",
    code: "KeyS",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    ...overrides,
  };
}

describe("document keyboard shortcuts", () => {
  it.each(["document", "title", "source"] as const)(
    "recognizes save and source while ignoring the former toolbar shortcut in %s context",
    (context) => {
      for (const modifier of [
        { ctrlKey: true, metaKey: false },
        { ctrlKey: false, metaKey: true },
      ]) {
        expect(classifyDocumentShortcut(keyEvent(modifier), context)).toBe(
          "save",
        );
        expect(
          classifyDocumentShortcut(
            keyEvent({ ...modifier, altKey: true, key: "e", code: "KeyE" }),
            context,
          ),
        ).toBeNull();
        expect(
          classifyDocumentShortcut(
            keyEvent({ ...modifier, altKey: true }),
            context,
          ),
        ).toBe("toggle-source");
      }
    },
  );

  it.each(["unrelated-input", "overlay"] as const)(
    "leaves %s shortcuts to their own controls",
    (context) => {
      expect(classifyDocumentShortcut(keyEvent(), context)).toBeNull();
      expect(
        classifyDocumentShortcut(keyEvent({ altKey: true }), context),
      ).toBeNull();
      expect(
        classifyDocumentShortcut(
          keyEvent({ altKey: true, key: "e", code: "KeyE" }),
          context,
        ),
      ).toBeNull();
    },
  );

  it.each([
    { key: "Dead", code: "KeyE", expected: null },
    { key: "´", code: "KeyE", expected: null },
    { key: "ß", code: "KeyS", expected: "toggle-source" },
  ])(
    "uses physical $code for an Option-modified $key",
    ({ key, code, expected }) => {
      expect(
        classifyDocumentShortcut(
          keyEvent({ ctrlKey: false, metaKey: true, altKey: true, key, code }),
          "document",
        ),
      ).toBe(expected);
    },
  );

  it.each([undefined, ""])(
    "falls back to the key only when code is absent (%s)",
    (code) => {
      expect(
        classifyDocumentShortcut(
          keyEvent({ code, key: "E", altKey: true }),
          "document",
        ),
      ).toBeNull();
      expect(
        classifyDocumentShortcut(
          keyEvent({ code, key: "S", altKey: true }),
          "document",
        ),
      ).toBe("toggle-source");
    },
  );

  it("does not let a conflicting logical key override an available physical code for source", () => {
    expect(
      classifyDocumentShortcut(
        keyEvent({ altKey: true, code: "KeyD", key: "s" }),
        "document",
      ),
    ).toBeNull();
    expect(
      classifyDocumentShortcut(
        keyEvent({ altKey: true, code: "KeyS", key: "e" }),
        "document",
      ),
    ).toBe("toggle-source");
  });

  it("preserves logical Mod+S across keyboard layouts and Caps Lock", () => {
    expect(
      classifyDocumentShortcut(
        keyEvent({ key: "s", code: "KeyO" }),
        "document",
      ),
    ).toBe("save");
    expect(
      classifyDocumentShortcut(
        keyEvent({ key: "S", shiftKey: false }),
        "document",
      ),
    ).toBe("save");
    expect(
      classifyDocumentShortcut(
        keyEvent({ key: "o", code: "KeyS" }),
        "document",
      ),
    ).toBeNull();
  });

  it.each(["isComposing", "defaultPrevented", "repeat", "shiftKey"] as const)(
    "ignores %s events",
    (flag) => {
      for (const override of [
        {},
        { altKey: true },
        { altKey: true, code: "KeyE", key: "e" },
      ]) {
        expect(
          classifyDocumentShortcut(
            keyEvent({ ...override, [flag]: true }),
            "document",
          ),
        ).toBeNull();
      }
    },
  );

  it("requires a Mod key and leaves unrelated combinations untouched", () => {
    for (const context of [
      "document",
      "title",
      "source",
    ] satisfies DocumentShortcutContext[]) {
      expect(
        classifyDocumentShortcut(
          keyEvent({ ctrlKey: false, altKey: true }),
          context,
        ),
      ).toBeNull();
      expect(
        classifyDocumentShortcut(keyEvent({ ctrlKey: false }), context),
      ).toBeNull();
      expect(
        classifyDocumentShortcut(keyEvent({ key: "e", code: "KeyE" }), context),
      ).toBeNull();
      expect(
        classifyDocumentShortcut(
          keyEvent({ key: "Escape", code: "Escape" }),
          context,
        ),
      ).toBeNull();
    }
  });

  it("does not treat AltGraph as Mod+Alt and preserves the modifier method receiver", () => {
    const event = keyEvent({
      altKey: true,
      getModifierState(key) {
        expect(this).toBe(event);
        return key === "AltGraph";
      },
    });
    expect(classifyDocumentShortcut(event, "document")).toBeNull();
    expect(
      classifyDocumentShortcut(
        keyEvent({ altKey: true, getModifierState: () => false }),
        "document",
      ),
    ).toBe("toggle-source");
  });
});
