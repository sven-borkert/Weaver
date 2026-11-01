import type { Editor } from "@tiptap/core";
import {
  CALLOUT_VARIANTS,
  type CalloutVariant,
} from "@weaver/core/editor/callout";
import {
  Bold,
  Code,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  Italic,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Megaphone,
  MessageSquareWarning,
  OctagonAlert,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  SquareCode,
  Strikethrough,
  Table2,
  TableProperties,
  TriangleAlert,
  Undo2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  activeCalloutVariant,
  applyCallout,
  canApplyCallout,
  removeCallout,
} from "~/lib/editor/callout-commands";

export type DocumentCommand = (editor: Editor) => void;

/** "keep": a modal the item opened owns focus; "after-close": run the item once the menu is gone. */
export type ToolbarCloseFocus = "editor" | "keep" | "after-close";

export type ToolbarMenuOption = {
  value: string;
  label: string;
  icon?: LucideIcon;
  disabled: boolean;
  onSelect: () => void;
};

export type ToolbarMenuEntry =
  | {
      kind: "item";
      label: string;
      icon?: LucideIcon;
      disabled: boolean;
      closeFocus?: ToolbarCloseFocus;
      onSelect: () => void;
    }
  | {
      kind: "radio";
      label: string;
      value: string;
      options: ToolbarMenuOption[];
    }
  | { kind: "separator" };

export type ToolbarControl =
  | {
      kind: "button";
      label: string;
      icon: LucideIcon;
      active?: boolean;
      disabled: boolean;
      closeFocus?: ToolbarCloseFocus;
      onSelect: () => void;
    }
  | {
      kind: "menu";
      id: string;
      /** Accessible name of the trigger and of its overflow submenu. */
      label: string;
      icon?: LucideIcon;
      text?: string;
      active?: boolean;
      disabled: boolean;
      entries: ToolbarMenuEntry[];
    };

export type ToolbarGroup = {
  id: string;
  label: string;
  controls: ToolbarControl[];
};

const LANGUAGES = [
  "plain",
  "bash",
  "css",
  "html",
  "javascript",
  "json",
  "python",
  "sql",
  "typescript",
];

const CALLOUT_ICONS: Record<CalloutVariant, LucideIcon> = {
  NOTE: Info,
  TIP: Lightbulb,
  IMPORTANT: MessageSquareWarning,
  WARNING: TriangleAlert,
  CAUTION: OctagonAlert,
};

export const calloutLabel = (variant: CalloutVariant) =>
  variant.charAt(0) + variant.slice(1).toLowerCase();

const HEADINGS = [
  { level: 1, icon: Heading1 },
  { level: 2, icon: Heading2 },
  { level: 3, icon: Heading3 },
] as const;

export function documentToolbarGroups({
  editor,
  disabled,
  run,
  onLink,
  onImage,
  onReference,
  onMermaid,
}: {
  editor: Editor;
  disabled: boolean;
  run: (command: DocumentCommand) => void;
  onLink: () => void;
  onImage: () => void;
  onReference: () => void;
  onMermaid?: () => void;
}): ToolbarGroup[] {
  const button = (
    label: string,
    icon: LucideIcon,
    command: DocumentCommand,
    options: { active?: boolean; unavailable?: boolean } = {},
  ): ToolbarControl => ({
    kind: "button",
    label,
    icon,
    active: options.active,
    disabled: disabled || Boolean(options.unavailable),
    onSelect: () => run(command),
  });
  const item = (
    label: string,
    command: DocumentCommand,
    unavailable = false,
    icon?: LucideIcon,
  ): ToolbarMenuEntry => ({
    kind: "item",
    label,
    icon,
    disabled: disabled || unavailable,
    onSelect: () => run(command),
  });

  const heading = HEADINGS.find(({ level }) =>
    editor.isActive("heading", { level }),
  )?.level;
  const styleValue = heading
    ? `heading-${heading}`
    : editor.isActive("paragraph")
      ? "paragraph"
      : "";
  const styleText = heading
    ? `Heading ${heading}`
    : styleValue
      ? "Paragraph"
      : undefined;
  const textStyle: ToolbarGroup = {
    id: "text-style",
    label: "Text style",
    controls: [
      {
        kind: "menu",
        id: "text-style",
        label: styleText ? `Text style: ${styleText}` : "Text style",
        text: styleText ?? "Style",
        disabled,
        entries: [
          {
            kind: "radio",
            label: "Text style",
            value: styleValue,
            options: [
              {
                value: "paragraph",
                label: "Paragraph",
                icon: Pilcrow,
                disabled,
                onSelect: () =>
                  run((current) => {
                    current.chain().focus().setParagraph().run();
                  }),
              },
              ...HEADINGS.map(({ level, icon }) => ({
                value: `heading-${level}`,
                label: `Heading ${level}`,
                icon,
                disabled,
                onSelect: () =>
                  run((current) => {
                    current.chain().focus().setHeading({ level }).run();
                  }),
              })),
            ],
          },
        ],
      },
    ],
  };

  const marks: ToolbarGroup = {
    id: "marks",
    label: "Text formatting",
    controls: [
      button(
        "Bold",
        Bold,
        (current) => {
          current.chain().focus().toggleBold().run();
        },
        { active: editor.isActive("bold") },
      ),
      button(
        "Italic",
        Italic,
        (current) => {
          current.chain().focus().toggleItalic().run();
        },
        { active: editor.isActive("italic") },
      ),
      button(
        "Strikethrough",
        Strikethrough,
        (current) => {
          current.chain().focus().toggleStrike().run();
        },
        { active: editor.isActive("strike") },
      ),
      button(
        "Inline code",
        Code,
        (current) => {
          current.chain().focus().toggleCode().run();
        },
        { active: editor.isActive("code") },
      ),
      {
        kind: "button",
        label: "Edit link",
        icon: Link2,
        active: editor.isActive("link"),
        disabled,
        closeFocus: "keep",
        onSelect: onLink,
      },
    ],
  };

  const variant = activeCalloutVariant(editor);
  const calloutAvailable = canApplyCallout(editor);
  const blocks: ToolbarGroup = {
    id: "blocks",
    label: "Lists and blocks",
    controls: [
      button(
        "Bullet list",
        List,
        (current) => {
          current.chain().focus().toggleBulletList().run();
        },
        { active: editor.isActive("bulletList") },
      ),
      button(
        "Numbered list",
        ListOrdered,
        (current) => {
          current.chain().focus().toggleOrderedList().run();
        },
        { active: editor.isActive("orderedList") },
      ),
      button(
        "Task list",
        ListTodo,
        (current) => {
          current.chain().focus().toggleTaskList().run();
        },
        { active: editor.isActive("taskList") },
      ),
      button(
        "Quote",
        Quote,
        (current) => {
          current.chain().focus().toggleBlockquote().run();
        },
        { active: editor.isActive("blockquote") },
      ),
      button(
        "Code block",
        SquareCode,
        (current) => {
          current.chain().focus().toggleCodeBlock().run();
        },
        { active: editor.isActive("codeBlock") },
      ),
      {
        kind: "menu",
        id: "callout",
        label: variant ? `Callout: ${calloutLabel(variant)}` : "Callout",
        icon: Megaphone,
        active: variant !== null,
        disabled: disabled || (!calloutAvailable && variant === null),
        entries: [
          {
            kind: "radio",
            label: "Callout type",
            value: variant ?? "",
            options: CALLOUT_VARIANTS.map((option) => ({
              value: option,
              label: calloutLabel(option),
              icon: CALLOUT_ICONS[option],
              disabled: disabled || !calloutAvailable,
              onSelect: () =>
                run((current) => {
                  applyCallout(current, option);
                }),
            })),
          },
          { kind: "separator" },
          item(
            "Remove callout",
            (current) => {
              removeCallout(current);
            },
            variant === null,
            RemoveFormatting,
          ),
        ],
      },
    ],
  };

  const contextual: ToolbarControl[] = [];
  if (editor.isActive("codeBlock")) {
    const language = String(
      editor.getAttributes("codeBlock").language ?? "plain",
    );
    const languageLabel = (value: string) =>
      value === "plain" ? "Plain text" : value;
    contextual.push({
      kind: "menu",
      id: "code-language",
      label: `Code language: ${languageLabel(language)}`,
      text: languageLabel(language),
      disabled,
      entries: [
        {
          kind: "radio",
          label: "Code language",
          value: language,
          options: LANGUAGES.map((value) => ({
            value,
            label: languageLabel(value),
            disabled,
            onSelect: () =>
              run((current) => {
                current
                  .chain()
                  .focus()
                  .updateAttributes("codeBlock", {
                    language: value === "plain" ? null : value,
                  })
                  .run();
              }),
          })),
        },
      ],
    });
  }
  if (editor.isActive("table")) {
    const can = editor.can();
    contextual.push({
      kind: "menu",
      id: "table",
      label: "Table options",
      icon: TableProperties,
      disabled,
      entries: [
        item(
          "Row above",
          (current) => {
            current.chain().focus().addRowBefore().run();
          },
          !can.addRowBefore(),
        ),
        item(
          "Row below",
          (current) => {
            current.chain().focus().addRowAfter().run();
          },
          !can.addRowAfter(),
        ),
        item(
          "Column before",
          (current) => {
            current.chain().focus().addColumnBefore().run();
          },
          !can.addColumnBefore(),
        ),
        item(
          "Column after",
          (current) => {
            current.chain().focus().addColumnAfter().run();
          },
          !can.addColumnAfter(),
        ),
        item("Header row", (current) => {
          current.chain().focus().toggleHeaderRow().run();
        }),
        { kind: "separator" },
        item(
          "Delete row",
          (current) => {
            current.chain().focus().deleteRow().run();
          },
          !can.deleteRow(),
        ),
        item(
          "Delete column",
          (current) => {
            current.chain().focus().deleteColumn().run();
          },
          !can.deleteColumn(),
        ),
        item("Delete table", (current) => {
          current.chain().focus().deleteTable().run();
        }),
      ],
    });
  }

  const insertEntries: ToolbarMenuEntry[] = [
    item(
      "Table",
      (current) => {
        current
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
      false,
      Table2,
    ),
    {
      kind: "item",
      label: "Image",
      icon: ImageIcon,
      disabled,
      closeFocus: "keep",
      onSelect: onImage,
    },
    {
      kind: "item",
      label: "Reference",
      icon: FileSymlink,
      disabled,
      // The picker is non-modal, so the closing menu must not take focus back.
      closeFocus: "after-close",
      onSelect: onReference,
    },
  ];
  if (onMermaid)
    insertEntries.push({
      kind: "item",
      label: "Mermaid diagram",
      icon: Workflow,
      disabled,
      onSelect: onMermaid,
    });

  const can = editor.can();
  return [
    textStyle,
    marks,
    blocks,
    ...(contextual.length
      ? [{ id: "contextual", label: "Selection tools", controls: contextual }]
      : []),
    {
      id: "insert",
      label: "Insert content",
      controls: [
        {
          kind: "menu",
          id: "insert",
          label: "Insert",
          icon: Plus,
          text: "Insert",
          disabled,
          entries: insertEntries,
        },
      ],
    },
    {
      id: "history",
      label: "History controls",
      controls: [
        button(
          "Undo",
          Undo2,
          (current) => {
            current.chain().focus().undo().run();
          },
          { unavailable: !can.undo() },
        ),
        button(
          "Redo",
          Redo2,
          (current) => {
            current.chain().focus().redo().run();
          },
          { unavailable: !can.redo() },
        ),
      ],
    },
  ];
}
