import { Mark, type Node } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

function reconcileNode(
  transaction: Transaction,
  before: Node,
  after: Node,
  position: number,
  root = false,
) {
  if (before.eq(after)) return;
  if (before.isText && after.isText) {
    const oldText = before.text!;
    const newText = after.text!;
    let start = 0;
    while (
      start < oldText.length &&
      start < newText.length &&
      oldText[start] === newText[start]
    )
      start += 1;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      oldText[oldEnd - 1] === newText[newEnd - 1]
    ) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    if (start !== oldEnd || start !== newEnd) {
      const text = newText.slice(start, newEnd);
      transaction.replaceWith(
        position + start,
        position + oldEnd,
        text ? after.type.schema.text(text, after.marks) : [],
      );
    }
    if (!Mark.sameSet(before.marks, after.marks)) {
      transaction.removeMark(position, position + newText.length);
      for (const mark of after.marks)
        transaction.addMark(position, position + newText.length, mark);
    }
    return;
  }

  const oldAttributes = before.attrs as Record<string, unknown>;
  const newAttributes = after.attrs as Record<string, unknown>;
  for (const [attribute, value] of Object.entries(newAttributes)) {
    if (JSON.stringify(oldAttributes[attribute]) === JSON.stringify(value))
      continue;
    if (root) transaction.setDocAttribute(attribute, value);
    else transaction.setNodeAttribute(position, attribute, value);
  }
  if (!root && !Mark.sameSet(before.marks, after.marks)) {
    transaction.setNodeMarkup(position, undefined, after.attrs, after.marks);
  }
  const contentStart = root ? position : position + 1;
  const sameChildren =
    before.childCount === after.childCount &&
    Array.from(
      { length: before.childCount },
      (_, index) => before.child(index).type === after.child(index).type,
    ).every(Boolean);
  if (sameChildren) {
    let childPosition = contentStart + before.content.size;
    for (let index = before.childCount - 1; index >= 0; index -= 1) {
      const child = before.child(index);
      childPosition -= child.nodeSize;
      reconcileNode(transaction, child, after.child(index), childPosition);
    }
    return;
  }
  const start = before.content.findDiffStart(after.content);
  if (start === null) return;
  const difference = before.content.findDiffEnd(after.content)!;
  const overlap = Math.max(0, start - Math.min(difference.a, difference.b));
  transaction.replace(
    contentStart + start,
    contentStart + difference.a + overlap,
    after.slice(start, difference.b + overlap),
  );
}

export function reconcileDocumentContent(
  state: EditorState,
  content: Node,
): Transaction {
  const transaction = state.tr
    .setMeta("addToHistory", false)
    .setMeta("preventUpdate", true);
  reconcileNode(transaction, state.doc, content, 0, true);
  return transaction;
}
