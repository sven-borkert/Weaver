import { CoreError } from "../errors";
import type { DocumentKind } from "./kinds";
import {
  documentOutlineFor,
  findSection,
  type DocumentSection,
} from "./outline";

export type PatchAction =
  | {
      action: "replace_text";
      find: string;
      replace: string;
      sectionId?: string;
      expectedMatches?: number;
    }
  | {
      action: "insert_before";
      anchor: string;
      text: string;
      sectionId?: string;
    }
  | { action: "insert_after"; anchor: string; text: string; sectionId?: string }
  | { action: "prepend"; text: string; sectionId?: string }
  | { action: "append"; text: string; sectionId?: string }
  | { action: "replace_section_body"; sectionId: string; text: string }
  | { action: "remove_section"; sectionId: string };

export type Edit = { start: number; end: number; text: string };

function ambiguous(message: string): CoreError {
  return new CoreError("BAD_REQUEST", message, { reason: "AMBIGUOUS_MATCH" });
}

function requireSection(
  sections: readonly DocumentSection[],
  id: string,
): DocumentSection {
  const section = findSection(sections, id);
  if (!section) throw ambiguous(`unknown section ${id}; re-read the outline`);
  return section;
}

/** Whole document, or one section's body including its descendants. */
function windowFor(
  sections: readonly DocumentSection[],
  sectionId: string | undefined,
  length: number,
): { from: number; to: number } {
  if (sectionId === undefined) return { from: 0, to: length };
  const section = requireSection(sections, sectionId);
  return { from: section.bodyStart, to: section.end };
}

function occurrences(
  haystack: string,
  needle: string,
  from: number,
  to: number,
): number[] {
  const found: number[] = [];
  let index = haystack.indexOf(needle, from);
  while (index !== -1 && index + needle.length <= to) {
    found.push(index);
    index = haystack.indexOf(needle, index + 1);
  }
  return found;
}

function locate(
  markdown: string,
  sections: readonly DocumentSection[],
  needle: string,
  sectionId: string | undefined,
  label: string,
  expected: number,
): number[] {
  const { from, to } = windowFor(sections, sectionId, markdown.length);
  const hits = occurrences(markdown, needle, from, to);
  if (hits.length !== expected)
    throw ambiguous(
      `${label} matched ${hits.length} times, expected ${expected}`,
    );
  return hits;
}

/** Resolves actions to non-overlapping ranges of the ORIGINAL markdown. */
export function compileDocumentPatch(
  markdown: string,
  actions: readonly PatchAction[],
  kind: DocumentKind,
): Edit[] {
  const sections = documentOutlineFor(kind, markdown);
  const edits: Edit[] = [];
  for (const action of actions) {
    switch (action.action) {
      case "replace_text": {
        const expected = action.expectedMatches ?? 1;
        for (const at of locate(
          markdown,
          sections,
          action.find,
          action.sectionId,
          "find",
          expected,
        ))
          edits.push({
            start: at,
            end: at + action.find.length,
            text: action.replace,
          });
        break;
      }
      case "insert_before": {
        const [at] = locate(
          markdown,
          sections,
          action.anchor,
          action.sectionId,
          "anchor",
          1,
        );
        edits.push({ start: at!, end: at!, text: action.text });
        break;
      }
      case "insert_after": {
        const [at] = locate(
          markdown,
          sections,
          action.anchor,
          action.sectionId,
          "anchor",
          1,
        );
        const end = at! + action.anchor.length;
        edits.push({ start: end, end, text: action.text });
        break;
      }
      case "prepend": {
        const { from } = windowFor(sections, action.sectionId, markdown.length);
        edits.push({ start: from, end: from, text: action.text });
        break;
      }
      case "append": {
        const { to } = windowFor(sections, action.sectionId, markdown.length);
        edits.push({ start: to, end: to, text: action.text });
        break;
      }
      case "replace_section_body": {
        const section = requireSection(sections, action.sectionId);
        edits.push({
          start: section.bodyStart,
          end: section.end,
          text: action.text,
        });
        break;
      }
      case "remove_section": {
        const section = requireSection(sections, action.sectionId);
        edits.push({ start: section.start, end: section.end, text: "" });
        break;
      }
    }
  }
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    // Equal starts catch two insertions at one position; the first test
    // catches genuine range overlap. Touching at prev.end is allowed.
    if (next.start < prev.end || next.start === prev.start)
      throw ambiguous("patch actions overlap or conflict at the same position");
  }
  return ordered;
}

export function applyDocumentPatch(
  markdown: string,
  actions: readonly PatchAction[],
  kind: DocumentKind,
): string {
  const edits = compileDocumentPatch(markdown, actions, kind);
  let out = markdown;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
