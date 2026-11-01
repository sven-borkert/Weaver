export type DiffLine = { type: "same" | "add" | "del"; text: string };

export type SideBySideRow = {
  left: DiffLine | null;
  right: DiffLine | null;
};

export function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.type === "same") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }

    const changed: DiffLine[] = [];
    while (index < lines.length && lines[index]!.type !== "same") {
      changed.push(lines[index]!);
      index += 1;
    }

    const deleted = changed.filter((item) => item.type === "del");
    const added = changed.filter((item) => item.type === "add");
    for (let row = 0; row < Math.max(deleted.length, added.length); row += 1) {
      rows.push({ left: deleted[row] ?? null, right: added[row] ?? null });
    }
  }

  return rows;
}
