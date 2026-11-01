import { CoreError } from "../errors";
import { validateTableWritePayload } from "../services/tables";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { validateRows } from "../tables/cellValues";
import { columnsShapeIssue } from "../tables/validation";
import {
  serializeRows,
  parseSchemaFile,
  serializeSchemaFile,
} from "../tables/jsonl";
import type { TableColumn, TableRow } from "../tables/types";
import type { MachineCommand } from "./schemas";
import type { MachineAction } from "./types";
import type {
  MachineDocumentSnapshot,
  MachineTableSnapshot,
} from "./snapshots";

export type GeneratedMachineIds = {
  resourceId: string;
  columnIds: string[];
  rowIds: string[];
  createdAt: string;
};
export type PreparedMachineChange = {
  actions: MachineAction[];
  markdown?: string;
  columns?: TableColumn[];
  rows?: TableRow[];
};
export function prepareMachineChange(
  command: MachineCommand,
  current: MachineDocumentSnapshot | MachineTableSnapshot | null,
  ids: GeneratedMachineIds,
): PreparedMachineChange {
  if (command.kind.startsWith("document")) {
    if (command.kind === "document.delete") return { actions: ["delete"] };
    if (!("markdown" in command)) throw new CoreError("BAD_REQUEST");
    if (
      /^\s*<!--\s*weaver(?:\s|$)/i.test(command.markdown) ||
      /^\s*---\r?\n(?:id|title|created|updated|createdBy|updatedBy):/i.test(
        command.markdown,
      )
    )
      throw new CoreError(
        "BAD_REQUEST",
        "Document headers are managed by Weaver",
      );
    const markdown = serializeDocumentBody(parseDocumentBody(command.markdown));
    if (Buffer.byteLength(markdown) > 2_000_000)
      throw new CoreError("BAD_REQUEST", "Document too large");
    return {
      actions: [command.kind === "document.create" ? "create" : "update"],
      markdown,
    };
  }
  if (command.kind === "table.delete") return { actions: ["delete"] };
  const before = current?.kind === "table" ? current : null;
  let columns: TableColumn[];
  let rows: TableRow[];
  const actions: MachineAction[] = [];
  if (command.kind === "table.create") {
    columns = command.columns.map((c, i) => ({ ...c, id: ids.columnIds[i]! }));
    rows = command.rows.map((r, i) => ({ ...r, id: ids.rowIds[i]! }));
    actions.push("create");
  } else {
    if (!before) throw new CoreError("NOT_FOUND");
    columns = before.columns;
    rows = before.rows;
    if (command.kind === "table.replace") {
      columns = command.columns;
      rows = command.rows;
      actions.push("update");
      if (rows.some((r) => !before.rows.some((old) => old.id === r.id)))
        actions.push("create");
      if (
        before.rows.some((old) => !rows.some((r) => r.id === old.id)) ||
        before.columns.some((old) => !columns.some((c) => c.id === old.id)) ||
        before.columns.some((old) =>
          old.options?.some(
            (o) =>
              !columns
                .find((c) => c.id === old.id)
                ?.options?.some((n) => n.id === o.id),
          ),
        )
      )
        actions.push("delete");
    } else if (command.kind === "rows.append") {
      rows = [
        ...before.rows,
        ...command.rows.map((r, i) => ({ ...r, id: ids.rowIds[i]! })),
      ];
      actions.push("create");
    } else if (command.kind === "rows.delete") {
      if (!rows.some((r) => r.id === command.rowId))
        throw new CoreError("NOT_FOUND");
      rows = rows.filter((r) => r.id !== command.rowId);
      actions.push("delete");
    } else if (command.kind === "rows.update") {
      const seen = new Set<string>();
      for (const patch of command.rows) {
        if (
          seen.has(patch.rowId) ||
          !rows.some((r) => r.id === patch.rowId) ||
          patch.clear.some(
            (id) => id in patch.set || !columns.some((c) => c.id === id),
          )
        )
          throw new CoreError("BAD_REQUEST", "Invalid row update");
        seen.add(patch.rowId);
      }
      rows = rows.map((r) => {
        const patch = command.rows.find((p) => p.rowId === r.id);
        if (!patch) return r;
        const cells = { ...r.cells, ...patch.set };
        for (const id of patch.clear) delete cells[id];
        return { id: r.id, cells };
      });
      actions.push("update");
    }
  }
  if (
    rows.length > 10_000 ||
    columnsShapeIssue(columns) ||
    !validateRows(columns, rows).ok ||
    Buffer.byteLength(serializeRows(columns, rows)) > 5_000_000
  )
    throw new CoreError("BAD_REQUEST", "Invalid or oversized table");
  const title =
    "title" in command && command.title
      ? command.title
      : (before?.title ?? "Table");
  validateTableWritePayload(title, columns, rows);
  parseSchemaFile(
    serializeSchemaFile({
      id: ids.resourceId,
      title:
        "title" in command && command.title
          ? command.title
          : (before?.title ?? "Table"),
      columns,
      sourceOfTruth: "git",
      created: ids.createdAt,
      updated: ids.createdAt,
    }),
  );
  return { actions: [...new Set(actions)], columns, rows };
}
