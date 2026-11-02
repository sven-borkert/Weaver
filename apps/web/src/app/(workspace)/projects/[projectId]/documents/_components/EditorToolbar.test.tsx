import { Editor } from "@tiptap/core";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type * as ReactModule from "react";
import type { ReactNode } from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tiptap/react", () => ({
  useEditorState: ({
    editor,
    selector,
  }: {
    editor: Editor;
    selector: (value: { editor: Editor; transactionNumber: number }) => unknown;
  }) => selector({ editor, transactionNumber: 0 }),
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
const overflow = vi.hoisted(() => ({ visible: Number.POSITIVE_INFINITY }));
vi.mock("~/lib/editor/use-toolbar-overflow", () => ({
  useToolbarOverflow: () => ({
    rowRef: { current: null },
    visible: overflow.visible,
  }),
}));
// Menus render their items inline; selecting one closes its menu like Radix.
vi.mock("~/components/ui/dropdown-menu", async () => {
  const { createContext, useContext } =
    await vi.importActual<typeof ReactModule>("react");
  type ItemProps = {
    children?: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  };
  const CloseAutoFocus = createContext<((event: Event) => void) | undefined>(
    undefined,
  );
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const item = (role: string) =>
    function MenuItem({ children, checked, disabled, onSelect }: ItemProps) {
      const close = useContext(CloseAutoFocus);
      return (
        <button
          role={role}
          aria-checked={checked}
          disabled={disabled}
          onClick={() => {
            onSelect?.(new Event("select"));
            close?.(new Event("close", { cancelable: true }));
          }}
        >
          {children}
        </button>
      );
    };
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({
      children,
      onCloseAutoFocus,
    }: {
      children?: ReactNode;
      onCloseAutoFocus?: (event: Event) => void;
    }) => (
      <CloseAutoFocus.Provider value={onCloseAutoFocus}>
        <div role="menu">{children}</div>
      </CloseAutoFocus.Provider>
    ),
    DropdownMenuGroup: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuItem: item("menuitem"),
    DropdownMenuRadioItem: item("menuitemradio"),
    DropdownMenuCheckboxItem: item("menuitemcheckbox"),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: ({
      children,
      disabled,
      "aria-label": label,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      "aria-label"?: string;
    }) => (
      <div
        role="menuitem"
        aria-haspopup="menu"
        aria-label={label}
        aria-disabled={disabled}
      >
        {children}
      </div>
    ),
    DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
  };
});
vi.mock("./CrossReferencePicker", () => ({ CrossReferencePicker: () => null }));

import { EditorToolbar } from "./EditorToolbar";

type EditorToolbarProps = Parameters<typeof EditorToolbar>[0];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
const liveEditors: Editor[] = [];
beforeEach(() => {
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(async () => {
  await act(() => tree?.unmount());
  overflow.visible = Number.POSITIVE_INFINITY;
  liveEditors.splice(0).forEach((editor) => editor.destroy());
  vi.unstubAllGlobals();
});

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});
function editorFixture() {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const listeners = new Map<
    string,
    (value: { transaction: Transaction }) => void
  >();
  let keydown: ((event: KeyboardEvent) => void) | undefined;
  const editor = {
    state: EditorState.create({ doc }),
    isEditable: true,
    isDestroyed: false,
    isFocused: false,
    commands: { focus: vi.fn() },
    isActive: () => false,
    can: () => ({ undo: () => false, redo: () => false }),
    getAttributes: () => ({}),
    on(name: string, callback: (value: { transaction: Transaction }) => void) {
      listeners.set(name, callback);
      return editor;
    },
    off(name: string) {
      listeners.delete(name);
      return editor;
    },
    view: {
      composing: false,
      dom: {
        closest: () => null,
        addEventListener: (
          _name: string,
          callback: (event: KeyboardEvent) => void,
        ) => {
          keydown = callback;
        },
        removeEventListener: vi.fn(),
      },
      dispatch(transaction: Transaction) {
        editor.state = editor.state.apply(transaction);
        listeners.get("transaction")?.({ transaction });
      },
    },
  };
  return { editor, keydown: (event: KeyboardEvent) => keydown?.(event) };
}
const slash = () => ({
  key: "/",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});
function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}
function button(label: string) {
  return tree!.root
    .findAllByType("button")
    .find((item) => (item.props["aria-label"] ?? textOf(item)) === label)!;
}
function menuOpenChange(label: string) {
  const trigger = button(label);
  let node: ReactTestInstance | null = trigger;
  while (node && typeof node.props.onOpenChange !== "function")
    node = node.parent;
  return (node!.props as { onOpenChange: (open: boolean) => void })
    .onOpenChange;
}
function closeAutoFocus(menu = "Insert") {
  let node: ReactTestInstance | null = button(menu);
  while (node && typeof node.props.onOpenChange !== "function")
    node = node.parent;
  return node!.find(
    (child) => typeof child.props.onCloseAutoFocus === "function",
  ).props.onCloseAutoFocus as (event: Event) => void;
}
function openMenus() {
  return tree!.root.findAll(
    (node) =>
      typeof node.props.onOpenChange === "function" && node.props.open === true,
  );
}
function moreMenu() {
  return tree!.root.find(
    (node) =>
      typeof node.props.onCloseAutoFocus === "function" &&
      node.props.align === "end",
  );
}
function realEditor(content: object[] = [{ type: "paragraph" }]) {
  const editor = new Editor({
    element: null,
    extensions: documentExtensions(),
    content: { type: "doc", content },
  });
  vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
  liveEditors.push(editor);
  return editor;
}

describe("EditorToolbar", () => {
  it("shows formatting before editor focus and restores the mapped cursor for upload", async () => {
    const { editor, keydown } = editorFixture();
    const upload = vi.fn(() => editor.state.selection.from);
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor as unknown as Editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
          onUploadImage={upload}
        />,
      );
    });
    expect(editor.commands.focus).not.toHaveBeenCalled();
    expect(
      tree!.root.findAllByProps({
        role: "toolbar",
        "aria-label": "Document formatting",
      }),
    ).toHaveLength(1);
    const slashEvent = slash();
    await act(() => keydown(slashEvent as unknown as KeyboardEvent));
    expect(slashEvent.preventDefault).not.toHaveBeenCalled();
    await act(() =>
      (button("Image").props as { onClick: () => void }).onClick(),
    );
    editor.view.dispatch(editor.state.tr.insertText("prefix", 1));
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );
    const file = new File(["image"], "sample.png", { type: "image/png" });
    const input = tree!.root.findByProps({ type: "file" });
    await act(() =>
      (
        input.props as {
          onChange: (event: { target: { files: File[] } }) => void;
        }
      ).onChange({ target: { files: [file] } }),
    );
    expect(upload).toHaveBeenCalledWith(file);
    expect(upload.mock.results[0]?.value).toBe(7);
    expect(editor.commands.focus).toHaveBeenCalled();
  });

  it("blocks an already-open image callback after saving disables editing", async () => {
    const { editor } = editorFixture();
    const upload = vi.fn();
    const input = {
      projectId: "project",
      editor: editor as unknown as Editor,
      crossReferenceOpen: false,
      onCrossReferenceOpenChange: vi.fn(),
      onUploadImage: upload,
      onViewSource: vi.fn(),
    };
    await act(() => {
      tree = create(<EditorToolbar {...input} disabled={false} />);
    });
    await act(() =>
      (button("Image").props as { onClick: () => void }).onClick(),
    );
    const pending = tree!.root.findByProps({ type: "file" }).props as {
      onChange: (event: { target: { files: File[] } }) => void;
    };
    await act(() => tree!.update(<EditorToolbar {...input} disabled />));
    await act(() =>
      pending.onChange({
        target: { files: [new File(["image"], "sample.png")] },
      }),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("keeps source available without exposing a toolbar visibility control or focusing the document", async () => {
    const { editor } = editorFixture();
    const onViewSource = vi.fn();
    const props = {
      projectId: "project",
      editor: editor as unknown as Editor,
      disabled: true,
      crossReferenceOpen: false,
      onCrossReferenceOpenChange: vi.fn(),
      onViewSource,
    };
    await act(() => {
      tree = create(<EditorToolbar {...props} />);
    });
    const source = button("View Markdown source");
    const hide = button("Hide formatting toolbar");
    expect(source).toBeDefined();
    expect(hide).toBeUndefined();
    expect(source.props["aria-keyshortcuts"]).toBe("Control+Alt+s Meta+Alt+s");
    await act(() => (source.props as { onClick: () => void }).onClick());
    expect(onViewSource).toHaveBeenCalledOnce();
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("keeps the formatted-view toggle available while source locks document commands", async () => {
    const { editor } = editorFixture();
    const onViewSource = vi.fn();
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor as unknown as Editor}
          disabled={false}
          sourceOpen
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={onViewSource}
        />,
      );
    });
    expect(button("Bold").props.disabled).toBe(true);
    expect(button("Image").props.disabled).toBe(true);
    const source = button("View formatted document");
    expect(source.props["aria-pressed"]).toBe(true);
    expect(source.props.disabled).toBeFalsy();
    await act(() => (source.props as { onClick: () => void }).onClick());
    expect(onViewSource).toHaveBeenCalledOnce();
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("combines formatting at an empty cursor for subsequently typed text", async () => {
    const editor = new Editor({
      element: null,
      extensions: documentExtensions(),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    liveEditors.push(editor);
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
        />,
      );
    });
    await act(() =>
      (button("Bold").props as { onClick: () => void }).onClick(),
    );
    await act(() =>
      (button("Italic").props as { onClick: () => void }).onClick(),
    );
    editor.view.dispatch(editor.state.tr.insertText("Typed text"));
    expect(editor.getJSON().content?.[0]?.content?.[0]).toEqual({
      type: "text",
      text: "Typed text",
      marks: [{ type: "bold" }, { type: "italic" }],
    });
  });

  it("applies a link to the original text range after intervening document edits", async () => {
    const editor = new Editor({
      element: null,
      extensions: documentExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Linked text" }],
          },
        ],
      },
    });
    vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    liveEditors.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 7 });
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
        />,
      );
    });
    await act(() =>
      (button("Edit link").props as { onClick: () => void }).onClick(),
    );
    await act(() =>
      (
        tree!.root.findByProps({ type: "url" }).props as {
          onChange: (event: { target: { value: string } }) => void;
        }
      ).onChange({ target: { value: "https://example.com" } }),
    );
    editor.view.dispatch(editor.state.tr.insertText("Prefix ", 1));
    editor.commands.setTextSelection(1);
    await act(() =>
      (
        tree!.root.findByType("form").props as {
          onSubmit: (event: { preventDefault: () => void }) => void;
        }
      ).onSubmit({ preventDefault: vi.fn() }),
    );
    const paragraph = editor.state.doc.firstChild;
    expect(paragraph?.child(0).toJSON()).toEqual({
      type: "text",
      text: "Prefix ",
    });
    expect(paragraph?.child(1).text).toBe("Linked");
    expect(paragraph?.child(1).marks.map((mark) => mark.type.name)).toEqual([
      "link",
    ]);
    expect(paragraph?.child(1).marks[0]?.attrs.href).toBe(
      "https://example.com",
    );
    expect(paragraph?.child(2).toJSON()).toEqual({
      type: "text",
      text: " text",
    });
  });

  it("refuses stale formatting and insertion callbacks after permission loss", async () => {
    const editor = new Editor({
      element: null,
      extensions: documentExtensions(),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
    liveEditors.push(editor);
    const mermaid = vi.fn();
    const math = vi.fn();
    const reference = vi.fn();
    const props = {
      projectId: "project",
      editor,
      disabled: false,
      crossReferenceOpen: false,
      onCrossReferenceOpenChange: reference,
      onViewSource: vi.fn(),
      onMermaid: mermaid,
      onMath: math,
    };
    await act(() => {
      tree = create(<EditorToolbar {...props} />);
    });
    const pending = [
      "Bold",
      "Heading 1",
      "Table",
      "Reference",
      "Mermaid diagram",
      "Inline formula",
      "Formula block",
      "Warning",
    ].map((label) => button(label).props as { onClick: () => void });
    const before = editor.getJSON();
    editor.setEditable(false);
    await act(() => tree!.update(<EditorToolbar {...props} />));
    for (const handler of pending) await act(() => handler.onClick());
    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.storedMarks).toBeNull();
    expect(mermaid).not.toHaveBeenCalled();
    expect(math).not.toHaveBeenCalled();
    expect(reference).not.toHaveBeenCalled();
    for (const control of tree!.root
      .findAllByType("button")
      .filter(
        (item) =>
          !["View Markdown source"].includes(String(item.props["aria-label"])),
      ))
      expect(control.props.disabled).toBe(true);
    expect(tree!.root.findAllByType("select")).toHaveLength(0);
    const openInsert = menuOpenChange("Insert");
    await act(() => openInsert(true));
    expect(
      tree!.root.findAll(
        (node) =>
          typeof node.props.onOpenChange === "function" &&
          node.props.open === true,
      ),
    ).toHaveLength(0);
  });

  it("wraps the selection in a callout, switches its type, and removes it", async () => {
    const editor = realEditor([
      { type: "paragraph", content: [{ type: "text", text: "Keep me" }] },
      { type: "paragraph", content: [{ type: "text", text: "And me" }] },
    ]);
    editor.commands.setTextSelection({ from: 2, to: 12 });
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
        />,
      );
    });
    expect(button("Remove callout").props.disabled).toBe(true);
    await act(() =>
      (button("Warning").props as { onClick: () => void }).onClick(),
    );
    const wrapped = editor.state.doc.firstChild!;
    const texts: string[] = [];
    wrapped.forEach((block) => texts.push(block.textContent));
    expect(wrapped.type.name).toBe("callout");
    expect(wrapped.attrs.variant).toBe("WARNING");
    expect(texts).toEqual(["Keep me", "And me"]);
    await act(() =>
      tree!.update(
        <EditorToolbar {...(tree!.root.props as EditorToolbarProps)} />,
      ),
    );
    expect(button("Callout: Warning").props["data-active"]).toBe(true);
    await act(() => (button("Tip").props as { onClick: () => void }).onClick());
    expect(editor.state.doc.firstChild!.attrs.variant).toBe("TIP");
    await act(() =>
      tree!.update(
        <EditorToolbar {...(tree!.root.props as EditorToolbarProps)} />,
      ),
    );
    expect(button("Callout: Tip")).toBeDefined();
    expect(button("Remove callout").props.disabled).toBe(false);
    await act(() =>
      (button("Remove callout").props as { onClick: () => void }).onClick(),
    );
    expect(editor.getJSON().content?.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(editor.state.doc.textContent).toBe("Keep meAnd me");
  });

  it("reports open toolbar menus as transient UI", async () => {
    const editor = realEditor();
    const onTransientOpenChange = vi.fn();
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
          onTransientOpenChange={onTransientOpenChange}
        />,
      );
    });
    expect(onTransientOpenChange).toHaveBeenLastCalledWith(false);
    await act(() => menuOpenChange("Insert")(true));
    expect(onTransientOpenChange).toHaveBeenLastCalledWith(true);
    await act(() => menuOpenChange("Insert")(false));
    expect(onTransientOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("groups text styles into one menu and places insert commands in their own menu", async () => {
    const editor = realEditor([
      { type: "paragraph", content: [{ type: "text", text: "Title" }] },
    ]);
    editor.commands.setTextSelection(2);
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
          onMermaid={vi.fn()}
        />,
      );
    });
    expect(button("Text style: Paragraph")).toBeDefined();
    await act(() =>
      (button("Heading 2").props as { onClick: () => void }).onClick(),
    );
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
    });
    await act(() =>
      tree!.update(
        <EditorToolbar {...(tree!.root.props as EditorToolbarProps)} />,
      ),
    );
    expect(button("Text style: Heading 2")).toBeDefined();
    const labels = tree!.root
      .findAllByProps({ role: "menu" })
      .map((menu) => menu.findAllByType("button").map(textOf));
    expect(labels).toContainEqual([
      "Table",
      "Image",
      "Reference",
      "Mermaid diagram",
    ]);
    expect(
      tree!.root.findAllByProps({ "aria-label": "Table options" }),
    ).toHaveLength(0);
  });
  it("opens the reference picker only after its menu has closed", async () => {
    const editor = realEditor();
    const reference = vi.fn();
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={reference}
          onViewSource={vi.fn()}
        />,
      );
    });
    const item = tree!.root.findAll(
      (node) =>
        typeof node.props.onSelect === "function" &&
        textOf(node) === "Reference",
    )[0]!;
    await act(() =>
      (item.props as { onSelect: (event: Event) => void }).onSelect(
        new Event("select"),
      ),
    );
    expect(reference).not.toHaveBeenCalled();
    const event = new Event("close", { cancelable: true });
    await act(() => closeAutoFocus()(event));
    expect(reference).toHaveBeenCalledWith(true);
    // Radix focuses the trigger first, so the menu cannot pull focus from the picker.
    expect(event.defaultPrevented).toBe(false);
  });

  it("moves overflowing groups into More with their states", async () => {
    overflow.visible = 2;
    const editor = realEditor([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Item" }] },
            ],
          },
        ],
      },
    ]);
    editor.commands.setTextSelection(4);
    await act(() => {
      tree = create(
        <EditorToolbar
          projectId="project"
          editor={editor}
          disabled={false}
          crossReferenceOpen={false}
          onCrossReferenceOpenChange={vi.fn()}
          onViewSource={vi.fn()}
          onMermaid={vi.fn()}
        />,
      );
    });
    const groups = tree!.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        typeof node.props["data-toolbar-group"] === "string",
    );
    expect(
      groups.map((group): unknown[] => [
        group.props["data-toolbar-group"],
        group.props["aria-hidden"] ?? false,
        group.props.inert ?? false,
      ]),
    ).toEqual([
      ["text-style", false, false],
      ["marks", false, false],
      ["blocks", true, true],
      ["insert", true, true],
      ["history", true, true],
    ]);
    expect(button("More formatting options").props.disabled).toBeFalsy();
    const more = moreMenu();
    const entry = (label: string) =>
      more
        .findAll(
          (node) =>
            typeof node.type === "string" &&
            typeof node.props.role === "string" &&
            node.props.role.startsWith("menuitem") &&
            (node.props["aria-label"] ?? textOf(node)) === label,
        )
        .at(0)!;
    expect(entry("Bullet list").props).toMatchObject({
      role: "menuitemcheckbox",
      "aria-checked": true,
    });
    expect(entry("Numbered list").props["aria-checked"]).toBe(false);
    expect(entry("Callout").props["aria-haspopup"]).toBe("menu");
    expect(entry("Insert").props["aria-haspopup"]).toBe("menu");
    expect(entry("Mermaid diagram").props.role).toBe("menuitem");
    expect(entry("Undo").props.disabled).toBe(true);
    expect(more.findAllByType("hr").length).toBeGreaterThanOrEqual(2);
    expect(
      more.findAll((node) => textOf(node) === "Bold" && node.type === "button"),
    ).toHaveLength(0);
  });

  it("returns focus to More when an open menu's group collapses into it", async () => {
    const { editor } = editorFixture();
    const focused: string[] = [];
    const onTransientOpenChange = vi.fn();
    const element = () => (
      <EditorToolbar
        projectId="project"
        editor={editor as unknown as Editor}
        disabled={false}
        crossReferenceOpen={false}
        onCrossReferenceOpenChange={vi.fn()}
        onViewSource={vi.fn()}
        onTransientOpenChange={onTransientOpenChange}
      />
    );
    await act(() => {
      tree = create(element(), {
        createNodeMock: (node) => {
          const label = String(
            (node.props as { "aria-label"?: string })["aria-label"],
          );
          return {
            isConnected: true,
            disabled: false,
            // Only the Insert trigger sits in a group that collapses below.
            closest: () => (label === "Insert" ? {} : null),
            focus: () => focused.push(label),
          };
        },
      });
    });
    // A plain dismiss leaves Radix to focus the still-visible trigger.
    const dismissed = new Event("close", { cancelable: true });
    await act(() => closeAutoFocus("Text style")(dismissed));
    expect(dismissed.defaultPrevented).toBe(false);
    await act(() => menuOpenChange("Insert")(true));
    expect(onTransientOpenChange).toHaveBeenLastCalledWith(true);
    overflow.visible = 2;
    await act(() => tree!.update(element()));
    expect(onTransientOpenChange).toHaveBeenLastCalledWith(false);
    expect(openMenus()).toHaveLength(0);
    const event = new Event("close", { cancelable: true });
    await act(() => closeAutoFocus()(event));
    expect(event.defaultPrevented).toBe(true);
    expect(focused).toEqual(["More formatting options"]);
    expect(editor.commands.focus).not.toHaveBeenCalled();
  });

  it("returns focus to the editor when an open More menu disappears", async () => {
    overflow.visible = 2;
    const { editor } = editorFixture();
    const element = () => (
      <EditorToolbar
        projectId="project"
        editor={editor as unknown as Editor}
        disabled={false}
        crossReferenceOpen={false}
        onCrossReferenceOpenChange={vi.fn()}
        onViewSource={vi.fn()}
      />
    );
    const focused: string[] = [];
    await act(() => {
      tree = create(element(), {
        createNodeMock: (node) => ({
          isConnected: true,
          disabled: false,
          closest: () => null,
          focus: () =>
            focused.push(
              String((node.props as { "aria-label"?: string })["aria-label"]),
            ),
        }),
      });
    });
    await act(() => menuOpenChange("More formatting options")(true));
    expect(openMenus()).toHaveLength(1);
    // Radix fires the unmounted menu's last close handler after the fact.
    const close = closeAutoFocus("More formatting options");
    overflow.visible = Number.POSITIVE_INFINITY;
    await act(() => tree!.update(element()));
    expect(button("More formatting options")).toBeUndefined();
    expect(openMenus()).toHaveLength(0);
    const event = new Event("close", { cancelable: true });
    await act(() => close(event));
    expect(focused).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.commands.focus).toHaveBeenCalledWith(undefined, {
      scrollIntoView: false,
    });
  });
});
