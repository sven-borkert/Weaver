import "client-only";

import { Extension } from "@tiptap/core";

export function createCrossrefTrigger(onOpen: () => void) {
  return Extension.create({
    name: "crossrefTrigger",
    addKeyboardShortcuts() {
      return {
        "[": ({ editor }) => {
          const { from, empty } = editor.state.selection;
          if (
            !empty ||
            from < 2 ||
            editor.state.doc.textBetween(from - 1, from) !== "["
          ) {
            return false;
          }

          editor.commands.deleteRange({ from: from - 1, to: from });
          onOpen();
          return true;
        },
      };
    },
  });
}
