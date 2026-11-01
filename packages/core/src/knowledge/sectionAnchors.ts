export const MAX_DOCUMENT_SECTION_COMPONENT_CHARACTERS = 48;
export const MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS = 180;
export const MAX_DOCUMENT_SECTION_HEADING_CHARACTERS = 200;

export type DocumentSectionAnchorProjection = {
  lineIndex: number;
  level: number;
  heading: string;
  anchor: string;
};

const headingPattern = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/;
const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})/;

const codePoints = (value: string) => Array.from(value);
const bounded = (value: string, maximum: number) =>
  codePoints(value).slice(0, maximum).join("");

function canonicalHeadingComponent(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DOCUMENT_SECTION_HEADING_CHARACTERS);
}

function component(value: string): string {
  return bounded(
    value
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, ""),
    MAX_DOCUMENT_SECTION_COMPONENT_CHARACTERS,
  ).replace(/-+$/gu, "");
}

export function createDocumentSectionAnchorAllocator(): {
  allocate(path: readonly string[]): string;
} {
  const used = new Set<string>();
  return {
    allocate(path) {
      const joined = path.map(component).filter(Boolean).join("--");
      const rawBase = joined ? `section-${joined}` : "section";
      const base =
        bounded(rawBase, MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS).replace(
          /-+$/gu,
          "",
        ) || "section";
      let suffix = "";
      let ordinal = 1;
      let candidate = base;
      while (used.has(candidate)) {
        ordinal += 1;
        suffix = `-${ordinal}`;
        candidate = `${bounded(
          base,
          MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS - codePoints(suffix).length,
        ).replace(/-+$/gu, "")}${suffix}`;
      }
      used.add(candidate);
      return candidate;
    },
  };
}

export function projectDocumentSectionAnchors(
  markdown: string,
): DocumentSectionAnchorProjection[] {
  const projections: DocumentSectionAnchorProjection[] = [];
  const headingLevels: string[] = [];
  const anchors = createDocumentSectionAnchorAllocator();
  let fence: { marker: "`" | "~"; length: number } | undefined;

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    if (fence) {
      if (isFenceEnd(line, fence.marker, fence.length)) fence = undefined;
      continue;
    }

    const fenceMatch = fenceStartPattern.exec(line);
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1]?.[0] as "`" | "~",
        length: fenceMatch[1]?.length ?? 3,
      };
      continue;
    }

    const headingMatch = headingPattern.exec(line);
    if (!headingMatch) continue;

    const level = headingMatch[1]?.length ?? 1;
    const heading = canonicalHeadingComponent(headingMatch[2] ?? "");
    headingLevels[level - 1] = heading;
    headingLevels.length = level;
    projections.push({
      lineIndex,
      level,
      heading,
      anchor: anchors.allocate(headingLevels.filter(Boolean)),
    });
  }

  return projections;
}

function isFenceEnd(line: string, marker: "`" | "~", length: number): boolean {
  return new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*$`).test(line);
}
