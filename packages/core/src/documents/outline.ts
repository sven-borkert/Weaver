import { projectDocumentSectionAnchors } from "../knowledge/sectionAnchors";
import type { DocumentKind } from "./kinds";
import { pythonDefinitions } from "./pythonOutline";

export type DocumentSection = {
  /** Anchor allocated by projectDocumentSectionAnchors; unique within this revision only. */
  id: string;
  heading: string;
  depth: number;
  /** Offset of the heading line. */
  start: number;
  /** Offset just past the heading line's newline. */
  bodyStart: number;
  /** Offset where this section (including descendants) ends. */
  end: number;
};

/** Character offset of the first character of each line, plus a final sentinel. */
function lineStarts(markdown: string): number[] {
  const starts = [0];
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] === "\r" && markdown[i + 1] === "\n") {
      i += 2;
      starts.push(i);
    } else if (markdown[i] === "\r" || markdown[i] === "\n") {
      i += 1;
      starts.push(i);
    } else {
      i += 1;
    }
  }
  return starts;
}

export function documentOutline(markdown: string): DocumentSection[] {
  const projections = projectDocumentSectionAnchors(markdown);
  if (projections.length === 0) return [];
  const starts = lineStarts(markdown);
  const sections: DocumentSection[] = projections.map((projection) => {
    const start = starts[projection.lineIndex] ?? markdown.length;
    const nextLine = starts[projection.lineIndex + 1];
    return {
      id: projection.anchor,
      heading: projection.heading,
      depth: projection.level,
      start,
      bodyStart: nextLine ?? markdown.length,
      end: markdown.length,
    };
  });
  for (let i = 0; i < sections.length; i++) {
    const current = sections[i]!;
    for (let j = i + 1; j < sections.length; j++) {
      const candidate = sections[j]!;
      if (candidate.depth <= current.depth) {
        current.end = candidate.start;
        break;
      }
    }
  }
  return sections;
}

export function pythonOutline(text: string): DocumentSection[] {
  const starts = lineStarts(text);
  const at = (line: number) => starts[line] ?? text.length;
  return pythonDefinitions(text).map((definition, ordinal) => ({
    id: `python:${definition.kind}:${definition.name}:${ordinal}`,
    heading: `${definition.kind} ${definition.name}`,
    depth: 1,
    start: at(definition.start),
    bodyStart: at(definition.bodyLine),
    end: at(definition.end),
  }));
}

export function documentOutlineFor(
  kind: DocumentKind,
  text: string,
): DocumentSection[] {
  return kind === "python" ? pythonOutline(text) : documentOutline(text);
}

export function findSection(
  sections: readonly DocumentSection[],
  id: string,
): DocumentSection | null {
  return sections.find((section) => section.id === id) ?? null;
}
