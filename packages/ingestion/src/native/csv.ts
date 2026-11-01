/** RFC 4180 rows; blank lines without syntax are skipped. Throws SyntaxError on bad quoting. */
export function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let rowHasSyntax = false;
  const invalid = () =>
    new SyntaxError("CSV contains an unterminated or misplaced quote");
  const endCell = () => {
    cells.push(cell);
    cell = "";
    closedQuote = false;
  };
  const endRow = () => {
    endCell();
    if (rowHasSyntax || cells.some((value) => value.trim().length > 0)) {
      rows.push(cells);
    }
    cells = [];
    rowHasSyntax = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      rowHasSyntax = true;
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (!cell && !closedQuote) {
        quoted = true;
      } else throw invalid();
      continue;
    }
    if (!quoted && character === ",") {
      rowHasSyntax = true;
      endCell();
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      endRow();
      continue;
    }
    if (closedQuote) throw invalid();
    cell += character;
  }
  if (quoted) throw invalid();
  endRow();
  return rows;
}
