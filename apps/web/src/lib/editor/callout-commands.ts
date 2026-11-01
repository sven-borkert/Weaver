import type { Editor } from "@tiptap/core";
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import { NodeRange } from "@tiptap/pm/model";
import {
  NodeSelection,
  type EditorState,
  type Selection,
} from "@tiptap/pm/state";
import { findWrapping, liftTarget } from "@tiptap/pm/transform";
import {
  CALLOUT_VARIANTS,
  type CalloutVariant,
} from "@weaver/core/editor/callout";

type FoundCallout = { node: PmNode; pos: number; depth: number };

const TABLE_CELLS = new Set(["tableCell", "tableHeader"]);
// Markdown cannot keep a callout inside a list item, so wrap the whole list.
const LIST_ITEMS = new Set(["listItem", "taskItem"]);

function isCalloutVariant(value: unknown): value is CalloutVariant {
  return (CALLOUT_VARIANTS as readonly unknown[]).includes(value);
}

function hasAncestor($pos: ResolvedPos, names: ReadonlySet<string>): boolean {
  for (let depth = $pos.depth; depth > 0; depth--)
    if (names.has($pos.node(depth).type.name)) return true;
  return false;
}

function selectedCallout(selection: Selection): FoundCallout | null {
  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== "callout"
  )
    return null;
  return {
    node: selection.node,
    pos: selection.from,
    depth: selection.$from.depth + 1,
  };
}

function activeCallout(selection: Selection): FoundCallout | null {
  const selected = selectedCallout(selection);
  if (selected) return selected;
  const { $from, $to } = selection;
  for (let depth = $from.sharedDepth($to.pos); depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "callout")
      return { node, pos: $from.before(depth), depth };
  }
  return null;
}

function nearestCallout(selection: Selection): FoundCallout | null {
  const selected = selectedCallout(selection);
  if (selected) return selected;
  const { $from: $pos } = selection;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "callout")
      return { node, pos: $pos.before(depth), depth };
  }
  return null;
}

function calloutWrapping(state: EditorState, variant: CalloutVariant) {
  const type = state.schema.nodes.callout;
  const { $from, $to } = state.selection;
  const callouts = new Set(["callout"]);
  if (
    !type ||
    hasAncestor($from, TABLE_CELLS) ||
    hasAncestor($to, TABLE_CELLS) ||
    hasAncestor($from, callouts) ||
    hasAncestor($to, callouts)
  )
    return null;
  const innermost = $from.blockRange($to);
  if (!innermost) return null;
  for (let depth = innermost.depth; depth >= 0; depth--) {
    if (LIST_ITEMS.has($from.node(depth).type.name)) continue;
    const range = new NodeRange($from, $to, depth);
    let nested = false;
    state.doc.nodesBetween(range.start, range.end, (node) => {
      if (node.type === type) nested = true;
      return !nested;
    });
    // Wider ranges would contain the same callout, so stop instead of nesting.
    if (nested) return null;
    const wrapping = findWrapping(range, type, { variant });
    if (wrapping) return { range, wrapping };
  }
  return null;
}

export function activeCalloutVariant(
  editor: Pick<Editor, "state">,
): CalloutVariant | null {
  const variant: unknown = activeCallout(editor.state.selection)?.node.attrs
    .variant;
  if (variant === undefined) return null;
  return isCalloutVariant(variant) ? variant : "NOTE";
}

export function canApplyCallout(editor: Pick<Editor, "state">): boolean {
  const { state } = editor;
  const { $from, $to } = state.selection;
  // Changing the type is safe anywhere inside a callout, even in a table cell.
  if (activeCallout(state.selection)) return true;
  if (hasAncestor($from, TABLE_CELLS) || hasAncestor($to, TABLE_CELLS))
    return false;
  return calloutWrapping(state, "NOTE") !== null;
}

/** Changes the surrounding callout's type, or wraps the touched blocks in a new callout. */
export function applyCallout(editor: Editor, variant: CalloutVariant): boolean {
  if (!canApplyCallout(editor)) return false;
  let applied = false;
  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const active = activeCallout(tr.selection);
      if (active) {
        applied = true;
        if (active.node.attrs.variant !== variant)
          tr.setNodeMarkup(active.pos, undefined, {
            ...active.node.attrs,
            variant,
          });
        return true;
      }
      const target = calloutWrapping(state, variant);
      if (!target) return false;
      tr.wrap(target.range, target.wrapping);
      applied = true;
      return true;
    })
    .run();
  return applied;
}

/** Replaces the nearest callout with its content. */
export function removeCallout(editor: Editor): boolean {
  if (!nearestCallout(editor.state.selection)) return false;
  let removed = false;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const callout = nearestCallout(tr.selection);
      if (!callout) return false;
      const range = new NodeRange(
        tr.doc.resolve(callout.pos + 1),
        tr.doc.resolve(callout.pos + callout.node.nodeSize - 1),
        callout.depth,
      );
      const target = liftTarget(range);
      if (target === null) return false;
      tr.lift(range, target);
      removed = true;
      return true;
    })
    .run();
  return removed;
}
