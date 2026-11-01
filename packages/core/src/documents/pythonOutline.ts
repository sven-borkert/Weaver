export type PythonDefinition = {
  kind: "def" | "class";
  name: string;
  /** Index of the def/class line. */
  line: number;
  /** First line after the signature (the line after the one ending in `:`). */
  bodyLine: number;
  /** First line of the group (decorators included). */
  start: number;
  /** Exclusive end line of the group. */
  end: number;
};

const DEFINITION_RE =
  /^(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;

// Column-0 lines that stay inside a group: comments, closing brackets of a signature.
const CONTINUATION_RE = /^[\s#)\]}]/;

/** The triple quote still open after `line`, skipping comments and one-line strings. */
function tripleQuoteAfter(line: string, open: string | null): string | null {
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (open !== null) {
      if (line.startsWith(open, index)) {
        index += 3;
        open = null;
      } else index++;
      continue;
    }
    if (char === "#") break;
    if (char !== '"' && char !== "'") {
      index++;
      continue;
    }
    if (line.startsWith(char.repeat(3), index)) {
      open = char.repeat(3);
      index += 3;
      continue;
    }
    index++;
    while (index < line.length && line[index] !== char)
      index += line[index] === "\\" ? 2 : 1;
    index++;
  }
  return open;
}

function endsSignature(line: string): boolean {
  return (
    line.trimEnd().endsWith(":") ||
    line.replace(/#.*$/, "").trimEnd().endsWith(":")
  );
}

/**
 * Top-level `def`/`class` groups of a module, in file order. Lines are split on LF.
 * A lexical scan of column 0 only; lines inside triple-quoted strings are continuations.
 */
export function pythonDefinitions(text: string): PythonDefinition[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // The trailing empty string of a final newline is not a line of its own.
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const found: PythonDefinition[] = [];
  let open: PythonDefinition | null = null;
  let decoratorStart: number | null = null;
  let openQuote: string | null = null;
  for (let index = 0; index < lineCount; index++) {
    const line = lines[index]!;
    const inString = openQuote !== null;
    openQuote = tripleQuoteAfter(line, openQuote);
    if (inString) continue;
    if (line.startsWith("@")) {
      if (open) open.end = index;
      open = null;
      decoratorStart ??= index;
      continue;
    }
    const match = DEFINITION_RE.exec(line);
    if (match) {
      if (open) open.end = index;
      open = {
        kind: match[1] as "def" | "class",
        name: match[2]!,
        line: index,
        bodyLine: index + 1,
        start: decoratorStart ?? index,
        end: lineCount,
      };
      found.push(open);
    } else if (open && line !== "" && !CONTINUATION_RE.test(line)) {
      open.end = index;
      open = null;
    }
    decoratorStart = null;
  }
  for (const definition of found)
    for (let index = definition.line; index < definition.end; index++)
      if (endsSignature(lines[index]!)) {
        definition.bodyLine = index + 1;
        break;
      }
  return found;
}
