"use client";

import { decodeCsvBytes } from "@weaver/core/tables/csv";

import { TRPCClientError } from "@trpc/client";
import { Table2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { MAX_DATA_FILE_BYTES } from "@weaver/core/tables/validation";
import { useBackgroundWork } from "~/components/background-work/BackgroundWorkProvider";
import type {
  ExplorerAdapter,
  ExplorerImport,
} from "~/components/explorer/adapter";
import { partitionDroppedCsvFiles } from "~/lib/tables/csv-drop";
import {
  tableHref,
  tableItemFromLeaf,
  tablesBase,
  type TableItem,
} from "~/lib/tables/explorer";
import { invalidateTableCaches } from "~/lib/tables/table-cache-invalidation";
import { api } from "~/trpc/react";
import { useExplorerOperations } from "~/components/explorer/useExplorerOperations";
import { CreateTableDialog } from "./CreateTableDialog";
import {
  CreateTableFolderDialog,
  TableFolderMutations,
} from "./TableFolderMutations";
import { TableMutations } from "./TableMutations";

function useTablesTree(projectId: string, enabled: boolean) {
  const { pageVisible } = useBackgroundWork();
  const query = api.tableFolder.tree.useQuery(
    { projectId },
    {
      enabled,
      refetchInterval: pageVisible ? 30_000 : false,
      refetchIntervalInBackground: false,
    },
  );
  const data = useMemo(
    () =>
      query.data
        ? {
            folders: query.data.folders,
            folderNames: query.data.folderNames,
            folderStamps: query.data.folderStamps,
            folderAppearances: query.data.folderAppearances,
            items: query.data.tables.map(tableItemFromLeaf),
          }
        : undefined,
    [query.data],
  );
  return {
    data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch(),
  };
}

function useCsvImport(
  projectId: string,
  folderPath: string[],
  canEdit: boolean,
): ExplorerImport | null {
  const utils = api.useUtils();
  const importCsv = api.table.importCsv.useMutation();
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  if (!canEdit) return null;
  return {
    hint: "Drop .csv files here to import",
    status: "Importing tables…",
    importing,
    run: async (files) => {
      if (importingRef.current) {
        toast.error("An import is already running. Wait for it to finish.");
        return;
      }
      const { csv, ignored } = partitionDroppedCsvFiles(files);
      if (ignored.length)
        toast.error(
          `Ignored ${ignored.length} file${ignored.length === 1 ? "" : "s"}: only .csv and .tsv files are imported.`,
        );
      if (!csv.length) return;
      importingRef.current = true;
      setImporting(true);
      let imported = 0;
      const failures: string[] = [];
      try {
        for (const file of csv) {
          try {
            if (file.size > MAX_DATA_FILE_BYTES) {
              failures.push(`${file.name} (too large)`);
              continue;
            }
            await importCsv.mutateAsync({
              projectId,
              folderPath,
              fileName: file.name,
              content: decodeCsvBytes(new Uint8Array(await file.arrayBuffer())),
            });
            imported += 1;
          } catch (error) {
            const message =
              error instanceof TRPCClientError ? error.message : undefined;
            failures.push(message ? `${file.name} (${message})` : file.name);
          }
        }
      } finally {
        importingRef.current = false;
        setImporting(false);
        void utils.tableFolder.tree.invalidate({ projectId });
        void utils.table.list.invalidate({ projectId });
      }
      if (imported)
        toast.success(`Imported ${imported} table${imported === 1 ? "" : "s"}`);
      if (failures.length)
        toast.error(`Could not import: ${failures.join(", ")}`);
    },
  };
}

// Stable identity: ContentExplorer only renders these actions while canEdit,
// so a demotion unmounts them and discards any open dialog state — a
// constant token suffices.
const editAccessToken = {};

function useMoveTable(projectId: string) {
  const utils = api.useUtils();
  const moveTable = api.table.move.useMutation();
  return async (tableId: string, folderPath: string[]) => {
    try {
      await moveTable.mutateAsync({ projectId, tableId, folderPath });
      toast.success("Table moved");
    } catch {
      toast.error("Could not move the table");
    } finally {
      await invalidateTableCaches(utils, projectId, tableId);
    }
  };
}

function TablesFolderActions({
  projectId,
  path,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  open,
  onOpenChange,
}: {
  projectId: string;
  path: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <TableFolderMutations
      projectId={projectId}
      path={path}
      folders={folders}
      folderNames={folderNames}
      canEdit={canEdit}
      onAppearance={onAppearance}
      editAccessToken={editAccessToken}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

function TablesItemActions({
  projectId,
  item,
  folderPath,
  folders,
  folderNames,
  canEdit,
  onAppearance,
  open,
  onOpenChange,
}: {
  projectId: string;
  item: TableItem;
  folderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
  canEdit: boolean;
  onAppearance?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <TableMutations
      projectId={projectId}
      tableId={item.id}
      tableTitle={item.title}
      tableFolderPath={folderPath}
      folders={folders}
      folderNames={folderNames}
      canEdit={canEdit}
      onAppearance={onAppearance}
      editAccessToken={editAccessToken}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

function TablesCreateItemDialog({
  projectId,
  folderPath,
  folders,
  folderNames,
}: {
  projectId: string;
  folderPath: string[];
  folders: string[];
  folderNames?: Record<string, string>;
}) {
  return (
    <CreateTableDialog
      projectId={projectId}
      folderPath={folderPath}
      folders={folders}
      folderNames={folderNames}
    />
  );
}

export const tablesExplorerAdapter: ExplorerAdapter<TableItem> = {
  kind: "tables",
  viewStorageKey: "weaver-tables-view",
  listLabel: "Tables and folders",
  itemNoun: ["table", "tables"],
  searchInputId: "table-search",
  itemIcon: () => Table2,
  base: tablesBase,
  itemHref: (projectId, item) => tableHref(projectId, item.id),
  useTree: useTablesTree,
  useMove: useMoveTable,
  useOperations: (projectId) => useExplorerOperations(projectId, "tables"),
  useImport: useCsvImport,
  columns: [
    {
      key: "rows",
      header: "Rows",
      cell: (item) => item.rowCount.toLocaleString(),
      className: "text-text-2 whitespace-nowrap",
    },
  ],
  tileMeta: (item, formatted) =>
    `${item.rowCount} row${item.rowCount === 1 ? "" : "s"} · ${formatted}`,
  FolderActions: TablesFolderActions,
  ItemActions: TablesItemActions,
  CreateFolderDialog: CreateTableFolderDialog,
  CreateItemDialog: TablesCreateItemDialog,
  copy: {
    workspaceLabel: "Table workspace",
    loadingTitle: "Loading tables",
    loadingDescription: "Retrieving folders and tables.",
    errorTitle: "Could not load tables",
    notFoundBackLabel: "Back to all tables",
    emptySearchTitle: "No matching tables",
    emptySearchDescription: "Try another title or clear the search.",
    emptyFolderTitle: "This folder is empty",
    emptyFolderDescription: "Add a table here or go up a level.",
    emptyRootTitle: "No tables yet",
    emptyRootDescription: "Create a table or drop a .csv file here.",
    dropZoneTestId: "tables-drop-zone",
  },
};
