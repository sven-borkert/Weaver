import {
  withAppearanceAssetsInRepo,
  type AppearanceAsset,
} from "./appearanceAssets";
import { normalizeAppearance, type Appearance } from "../appearance/metadata";
import { randomUUID } from "node:crypto";
import { mapWithConcurrency } from "@weaver/core/ai/concurrency";
import { CoreError } from "@weaver/core/errors";
import { Prisma, type DataTable, type PrismaClient } from "@weaver/db/client";
import {
  assertSafeSegments,
  folderNotFound,
} from "@weaver/core/documents/paths";
import { documentTitleSchema } from "@weaver/core/documents/title";
import { slugify } from "@weaver/core/documents/slug";
import { validateRows } from "@weaver/core/tables/cellValues";
import { diffTables, type TableDiff } from "@weaver/core/tables/diff";
import {
  parseRows,
  parseSchemaFile,
  serializeRows,
  serializeSchemaFile,
  TableFileError,
} from "@weaver/core/tables/jsonl";
import { mergeTables } from "@weaver/core/tables/merge";
import {
  TABLES_ROOT,
  folderPathOfTableDir,
  isTableDirName,
  slugFromTableDir,
  tableDirPath,
} from "@weaver/core/tables/paths";
import {
  hasOptions,
  COLUMN_TYPES as TABLE_COLUMN_TYPES,
} from "@weaver/core/tables/types";
import type {
  SchemaFile,
  TableColumn,
  TableData,
  TableRow,
} from "@weaver/core/tables/types";
import {
  CANONICAL_UUID_RE,
  MAX_DATA_FILE_BYTES,
  MAX_TABLE_COLUMNS,
  MAX_TEXT_CHARS,
  columnShapeIssue,
} from "@weaver/core/tables/validation";
import { wikiAgentEmail } from "./wikiAgents";
import {
  machineEditorOf,
  machineRefOf,
  resolveAttribution,
  type EnrichedActor,
} from "./documents";
import {
  gitAuthorForContent,
  documentAuthorForContent,
  contentUserId,
  machineEditorColumns,
  machineEditorFromRow,
  machineIdentity,
  type ContentWriteActor,
  type MachineEditor,
  type MachineEditorRef,
} from "./contentAuthor";
import {
  type GitLogEntry,
  type ProjectRepoReader,
  type ProjectRepoWriter,
} from "@weaver/git-store";
import { assertProjectRole, type ProjectActor } from "./projectAccess";
import { withExistingProjectRepoReader, withProjectRepo } from "./projectRepo";
import { resolveSnapshotCommit } from "./contentSnapshots";
import {
  enqueueContentDeleted,
  enqueueProjectReconcile,
  enqueueTableChanged,
} from "./knowledgeReconciliation";
import { notifyProjectContentChanged } from "./projectGitRemoteJobs";
import { captureError } from "../diagnostics/writer";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_TABLE_ROWS = 10_000;
export { MAX_TABLE_COLUMNS, MAX_DATA_FILE_BYTES, MAX_TEXT_CHARS };
export const MAX_SCHEMA_FILE_BYTES = 250_000;

const MAX_TABLE_DIFF_CELLS = 200_000;
const TABLE_HISTORY_BATCH_SIZE = 100;
const MAX_TABLE_DISCOVERY_CANDIDATES = 10_000;
const MAX_TABLE_HISTORY_CANDIDATES = 2_000;
const TABLE_DISCOVERY_CONCURRENCY = 8;
const COLUMN_TYPES = new Set<string>(TABLE_COLUMN_TYPES);
const LARGE_TABLE_HINT =
  "Phase 2 tables are limited to 10,000 rows / 5 MB; larger tables arrive with the Phase 6 outbox path";

class TablePayloadError extends CoreError {
  constructor(message: string) {
    super("BAD_REQUEST", message);
  }
}

const author = gitAuthorForContent;

export type TableWriteResult = {
  id: string;
  path: string;
  slug: string;
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  headCommitSha: string;
};

export type TableLogEntry = GitLogEntry & {
  dirAtSha: string;
  candidateDirsAtSha: string[];
};

type HistoryTableMatch = {
  dir: string;
  trackedFiles: string[];
};

export async function tableLogForDir(
  repo: ProjectRepoReader,
  dir: string,
  {
    skip,
    limit,
    commitish = "HEAD",
  }: { skip: number; limit: number; commitish?: string },
): Promise<TableLogEntry[]> {
  const want = skip + limit;
  const [schemaLog, dataLog] = await Promise.all([
    repo.logForPath(`${dir}/schema.json`, {
      skip: 0,
      limit: want,
      commitish,
    }),
    repo.logForPath(`${dir}/data.jsonl`, {
      skip: 0,
      limit: want,
      commitish,
    }),
  ]);
  const bySha = new Map<string, TableLogEntry>();
  for (const entry of [...schemaLog, ...dataLog]) {
    const dirAtSha = entry.pathAtSha.split("/").slice(0, -1).join("/");
    const existing = bySha.get(entry.sha);
    if (existing) {
      if (!existing.candidateDirsAtSha.includes(dirAtSha)) {
        existing.candidateDirsAtSha.push(dirAtSha);
      }
    } else {
      bySha.set(entry.sha, {
        ...entry,
        dirAtSha,
        candidateDirsAtSha: [dirAtSha],
      });
    }
  }
  const orderedShas = await repo.orderCommits(commitish, [...bySha.keys()]);
  return orderedShas.map((sha) => bySha.get(sha)!).slice(skip, skip + limit);
}

const historyBlobs = new Map<
  string,
  Awaited<ReturnType<ProjectRepoReader["listTrackedBlobs"]>>
>();

async function historyBlobsAt(repo: ProjectRepoReader, sha: string) {
  const cached = historyBlobs.get(sha);
  if (cached) {
    historyBlobs.delete(sha);
    historyBlobs.set(sha, cached);
    return cached;
  }
  const blobs = await repo.listTrackedBlobs(sha);
  if (blobs.length <= 10_000) {
    historyBlobs.set(sha, blobs);
    if (historyBlobs.size > 16)
      historyBlobs.delete(historyBlobs.keys().next().value!);
  }
  return blobs;
}

async function matchingHistoryDirAtCommit(
  repo: ProjectRepoReader,
  entry: Pick<TableLogEntry, "sha" | "candidateDirsAtSha">,
  tableId: string,
  schemaIds = new Map<string, string | null>(),
): Promise<HistoryTableMatch | null> {
  const blobs = await historyBlobsAt(repo, entry.sha);
  const blobsByPath = new Map(blobs.map((blob) => [blob.path, blob]));
  const tracked = blobs.map((blob) => blob.path);
  const filesByDir = canonicalTableCandidateFiles(tracked);
  const candidateDirs = new Set(filesByDir.keys());
  for (const dir of entry.candidateDirsAtSha) {
    if (isCanonicalTableDir(dir)) candidateDirs.add(dir);
  }
  if (candidateDirs.size > MAX_TABLE_DISCOVERY_CANDIDATES) {
    throw new CoreError(
      "PRECONDITION_FAILED",
      "table discovery exceeds the supported table count",
    );
  }
  const matches = await mapWithConcurrency(
    [...candidateDirs],
    TABLE_DISCOVERY_CONCURRENCY,
    async (dir) => {
      const schemaPath = `${dir}/schema.json`;
      const dataPath = `${dir}/data.jsonl`;
      if (!hasExactTableLayout(filesByDir.get(dir) ?? [], dir)) return null;
      const schemaBlob = blobsByPath.get(schemaPath);
      const schemaSize = schemaBlob?.size ?? null;
      const dataSize = blobsByPath.get(dataPath)?.size ?? null;
      if (
        schemaSize === null ||
        schemaSize > MAX_SCHEMA_FILE_BYTES ||
        dataSize === null ||
        dataSize > MAX_DATA_FILE_BYTES
      ) {
        return null;
      }
      const blobSha = schemaBlob!.sha;
      if (!schemaIds.has(blobSha)) {
        try {
          const parsed = JSON.parse(
            await repo.showFileAt(entry.sha, schemaPath),
          ) as { id?: unknown } | null;
          schemaIds.set(
            blobSha,
            typeof parsed?.id === "string" ? parsed.id : null,
          );
        } catch {
          schemaIds.set(blobSha, null);
        }
      }
      return schemaIds.get(blobSha) === tableId ? dir : null;
    },
  );
  const matchingDirs = matches.filter((dir): dir is string => dir !== null);
  return matchingDirs.length === 1
    ? { dir: matchingDirs[0]!, trackedFiles: tracked }
    : null;
}

async function validatedTableHistory(
  repo: ProjectRepoReader,
  currentDir: string,
  tableId: string,
  want: number,
  snapshotSha: string,
): Promise<TableLogEntry[]> {
  const valid: TableLogEntry[] = [];
  const schemaIds = new Map<string, string | null>();
  const seen = new Set<string>();
  const scan = async (
    load: (limit: number) => Promise<TableLogEntry[]>,
  ): Promise<boolean> => {
    let processed = 0;
    let window = TABLE_HISTORY_BATCH_SIZE;
    for (;;) {
      const raw = await load(window + 1);
      for (const entry of raw.slice(processed, window)) {
        if (seen.has(entry.sha)) continue;
        seen.add(entry.sha);
        const match = await matchingHistoryDirAtCommit(
          repo,
          entry,
          tableId,
          schemaIds,
        );
        if (!match) continue;
        const snapshot = await readTableAt(repo, entry.sha, match.dir, {
          trackedFiles: match.trackedFiles,
        });
        if (snapshot?.entry.sha !== entry.sha) continue;
        valid.push({ ...entry, dirAtSha: match.dir });
        if (valid.length >= want) return true;
      }
      if (raw.length <= window) return false;
      if (window >= MAX_TABLE_HISTORY_CANDIDATES) {
        throw new CoreError(
          "PRECONDITION_FAILED",
          "table history exceeds the supported scan limit",
        );
      }
      processed = window;
      window = Math.min(window * 2, MAX_TABLE_HISTORY_CANDIDATES);
    }
  };

  if (
    await scan((limit) =>
      tableLogForDir(repo, currentDir, {
        skip: 0,
        limit,
        commitish: snapshotSha,
      }),
    )
  ) {
    return valid;
  }
  if (valid.at(-1)?.message.startsWith("create:")) return valid;
  await scan(async (limit) =>
    (
      await repo.logForPath(TABLES_ROOT, {
        skip: 0,
        limit,
        commitish: snapshotSha,
      })
    ).map((entry) => ({
      ...entry,
      dirAtSha: "",
      candidateDirsAtSha: [],
    })),
  );
  const ordered = await repo.orderCommits(
    snapshotSha,
    valid.map((entry) => entry.sha),
  );
  const bySha = new Map(valid.map((entry) => [entry.sha, entry]));
  return ordered.map((sha) => bySha.get(sha)!);
}

export async function tableDirAtCommit(
  repo: ProjectRepoReader,
  currentDir: string,
  tableId: string,
  sha: string,
  pinnedHead: string,
): Promise<string | null> {
  if (!(await repo.isAncestor(sha, pinnedHead))) return null;
  try {
    const match = await matchingHistoryDirAtCommit(
      repo,
      {
        sha,
        candidateDirsAtSha: [currentDir],
      },
      tableId,
    );
    if (!match) return null;
    const [entry] = await tableLogForDir(repo, match.dir, {
      skip: 0,
      limit: 1,
      commitish: sha,
    });
    return entry?.sha === sha ? match.dir : null;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    return null;
  }
}

type TableSnapshot = {
  schema: SchemaFile;
  rows: TableRow[];
  entry: TableLogEntry;
};

function exceedsTableDiffCaps(
  columns: TableColumn[],
  rows: TableRow[],
): boolean {
  return (
    rows.length > MAX_TABLE_ROWS ||
    columns.length > MAX_TABLE_COLUMNS ||
    rows.length * columns.length > MAX_TABLE_DIFF_CELLS
  );
}

function titleIssue(title: string): string | null {
  if (title.length === 0 || title !== title.trim()) {
    return "title must be trimmed and nonempty";
  }
  if (title.length > 200) return "title exceeds 200 characters";
  const parsed = documentTitleSchema.safeParse(title);
  return parsed.success ? null : parsed.error.issues[0]!.message;
}

function tableDataIssue(
  columns: TableColumn[],
  rows: TableRow[],
): string | null {
  if (columns.length > MAX_TABLE_COLUMNS) return "too many columns";
  const columnIds = new Set<string>();
  for (const column of columns) {
    if (!CANONICAL_UUID_RE.test(column.id))
      return `invalid column id ${column.id}`;
    if (columnIds.has(column.id)) return `duplicate column id ${column.id}`;
    columnIds.add(column.id);
    if (
      column.name.length === 0 ||
      column.name !== column.name.trim() ||
      column.name.length > 100
    ) {
      return `invalid column name ${column.id}`;
    }
    if (!COLUMN_TYPES.has(column.type)) {
      return `unknown column type ${column.id}`;
    }
    const shape = columnShapeIssue(column);
    if (shape) return shape;
    if (hasOptions(column.type)) {
      const optionIds = new Set<string>();
      for (const option of column.options!) {
        if (!CANONICAL_UUID_RE.test(option.id) || optionIds.has(option.id)) {
          return `invalid or duplicate option id ${column.id}`;
        }
        optionIds.add(option.id);
        if (
          option.label.length === 0 ||
          option.label !== option.label.trim() ||
          option.label.length > 100
        ) {
          return `invalid option label ${column.id}`;
        }
      }
    }
  }
  if (rows.length > MAX_TABLE_ROWS) return LARGE_TABLE_HINT;
  const rowIds = new Set<string>();
  for (const row of rows) {
    if (!CANONICAL_UUID_RE.test(row.id)) return `invalid row id ${row.id}`;
    if (rowIds.has(row.id)) return `duplicate row id ${row.id}`;
    rowIds.add(row.id);
    for (const value of Object.values(row.cells)) {
      if (typeof value === "string" && value.length > MAX_TEXT_CHARS) {
        return `cell text exceeds ${MAX_TEXT_CHARS} characters`;
      }
    }
  }
  const check = validateRows(columns, rows);
  if (!check.ok) {
    const first = check.errors[0]!;
    return `invalid cell (row ${first.rowId}, column ${first.columnId}: ${first.reason})`;
  }
  return null;
}

function assertValidTableData(columns: TableColumn[], rows: TableRow[]): void {
  const issue = tableDataIssue(columns, rows);
  if (issue) throw new TablePayloadError(issue);
}

function assertValidTitle(title: string): void {
  const issue = titleIssue(title);
  if (issue) throw new TablePayloadError(issue);
}

export function validateTableWritePayload(
  title: string,
  columns: TableColumn[],
  rows: TableRow[],
): void {
  assertInputByteBudget(title, columns, rows);
  assertValidTitle(title);
  assertValidTableData(columns, rows);
}

async function readTableAt(
  repo: ProjectRepoReader,
  commitish: string,
  dir: string,
  {
    allowOversizedDiff = false,
    trackedFiles,
  }: {
    allowOversizedDiff?: boolean;
    trackedFiles?: string[];
  } = {},
): Promise<TableSnapshot | null> {
  const schemaPath = `${dir}/schema.json`;
  const dataPath = `${dir}/data.jsonl`;
  const schemaBlob = await repo.blobShaAt(commitish, schemaPath);
  if (!schemaBlob) return null;
  const snapshotFiles =
    trackedFiles ?? (await repo.listTrackedFiles(commitish));
  const files = snapshotFiles.filter((file) => file.startsWith(`${dir}/`));
  if (!hasExactTableLayout(files, dir)) {
    throw new TableFileError(
      "table directory must contain exactly schema.json and data.jsonl",
    );
  }
  const [schemaSize, dataBlob] = await Promise.all([
    repo.blobSizeAt(commitish, schemaPath),
    repo.blobShaAt(commitish, dataPath),
  ]);
  if (schemaSize === null || schemaSize > MAX_SCHEMA_FILE_BYTES) {
    throw new TableFileError("schema.json exceeds the size cap");
  }
  if (!dataBlob) throw new TableFileError("data.jsonl is missing");
  const dataSize = await repo.blobSizeAt(commitish, dataPath);
  if (dataSize === null || dataSize > MAX_DATA_FILE_BYTES) {
    throw new TableFileError("data.jsonl exceeds the size cap");
  }
  const [schemaText, dataText, entries] = await Promise.all([
    repo.showFileAt(commitish, schemaPath),
    repo.showFileAt(commitish, dataPath),
    tableLogForDir(repo, dir, { skip: 0, limit: 1, commitish }),
  ]);
  const schema = parseSchemaFile(schemaText);
  const rows = parseRows(dataText);
  const oversizedDiff =
    allowOversizedDiff && exceedsTableDiffCaps(schema.columns, rows);
  const issue =
    titleIssue(schema.title) ??
    (oversizedDiff ? null : tableDataIssue(schema.columns, rows));
  if (issue) throw new TableFileError(issue);
  const entry = entries[0];
  if (!entry) throw new TableFileError("table has no commit history");
  return { schema, rows, entry };
}

async function readTableAtSafe(
  repo: ProjectRepoReader,
  commitish: string,
  dir: string,
  options?: { allowOversizedDiff?: boolean; trackedFiles?: string[] },
): Promise<TableSnapshot | null> {
  try {
    return await readTableAt(repo, commitish, dir, options);
  } catch (error) {
    if (error instanceof TableFileError) {
      console.error("Table file failed to parse", { dir, commitish, error });
      throw new CoreError(
        "INTERNAL_SERVER_ERROR",
        "table files are corrupt; run rebuild or fix in git",
      );
    }
    throw error;
  }
}

function canonicalTableDirForFile(
  file: string,
  filename: "schema.json" | "data.jsonl",
): string | null {
  const suffix = `/${filename}`;
  if (!file.startsWith(`${TABLES_ROOT}/`) || !file.endsWith(suffix)) {
    return null;
  }
  const dir = file.slice(0, -suffix.length);
  const segments = dir.split("/");
  const leaf = segments.at(-1);
  if (!leaf || !isTableDirName(leaf)) return null;
  const folders = segments.slice(1, -1);
  try {
    assertSafeSegments(folders);
    const slug = slugFromTableDir(leaf);
    return tableDirPath(folders, slug) === dir ? dir : null;
  } catch {
    return null;
  }
}

function candidateTableDirForTrackedFile(file: string): string | null {
  const segments = file.split("/");
  if (segments[0] !== TABLES_ROOT) return null;
  const tableIndex = segments.findIndex(
    (segment, index) => index > 0 && segment.endsWith(".table"),
  );
  return tableIndex > 0 ? segments.slice(0, tableIndex + 1).join("/") : null;
}

function isCanonicalTableDir(dir: string): boolean {
  return canonicalTableDirForFile(`${dir}/schema.json`, "schema.json") === dir;
}

function canonicalTableCandidateFiles(
  trackedFiles: readonly string[],
): Map<string, string[]> {
  const filesByDir = new Map<string, string[]>();
  for (const file of trackedFiles) {
    const dir = candidateTableDirForTrackedFile(file);
    if (!dir || !isCanonicalTableDir(dir)) continue;
    const files = filesByDir.get(dir) ?? [];
    files.push(file);
    filesByDir.set(dir, files);
  }
  return filesByDir;
}

function hasExactTableLayout(files: readonly string[], dir: string): boolean {
  return (
    files.length === 2 &&
    files.includes(`${dir}/schema.json`) &&
    files.includes(`${dir}/data.jsonl`)
  );
}

async function discoverTableDirById(
  repo: ProjectRepoReader,
  commitish: string,
  tableId: string,
  trackedFiles?: string[],
): Promise<string | null> {
  const snapshotFiles =
    trackedFiles ?? (await repo.listTrackedFiles(commitish));
  const schemaPaths = snapshotFiles.filter(
    (file) => canonicalTableDirForFile(file, "schema.json") !== null,
  );
  if (schemaPaths.length > MAX_TABLE_DISCOVERY_CANDIDATES) {
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "table index scan exceeds the supported table count",
    );
  }
  let found: string | null = null;
  for (const schemaPath of schemaPaths) {
    const size = await repo.blobSizeAt(commitish, schemaPath);
    if (size === null || size > MAX_SCHEMA_FILE_BYTES) continue;
    let candidateId: unknown;
    try {
      const parsed = JSON.parse(
        await repo.showFileAt(commitish, schemaPath),
      ) as { id?: unknown } | null;
      candidateId = parsed?.id;
    } catch {
      continue;
    }
    if (candidateId !== tableId) continue;
    const dir = canonicalTableDirForFile(schemaPath, "schema.json")!;
    if (found && found !== dir) {
      throw new CoreError(
        "INTERNAL_SERVER_ERROR",
        "duplicate table id in git; run rebuild or fix in git",
      );
    }
    found = dir;
  }
  return found;
}

type LocatedTable = {
  dir: string;
  slug: string;
  snapshot: TableSnapshot;
};

function slugForTableDir(dir: string): string {
  try {
    return slugFromTableDir(dir.split("/").at(-1)!);
  } catch {
    throw new CoreError(
      "INTERNAL_SERVER_ERROR",
      "table path is corrupt; run rebuild or fix in git",
    );
  }
}

async function locateTableAtHead(
  repo: ProjectRepoReader,
  head: string,
  tableId: string,
  row: DataTable | null,
  trackedFiles?: string[],
): Promise<LocatedTable | null> {
  const snapshotFiles = trackedFiles ?? (await repo.listTrackedFiles(head));
  const candidates = new Set<string>();
  if (row) {
    candidates.add(row.path);
    for (const filename of row.headCommitSha === head ||
    snapshotFiles.includes(`${row.path}/schema.json`)
      ? []
      : (["schema.json", "data.jsonl"] as const)) {
      const renamed = await repo.renamedPathBetween(
        row.headCommitSha,
        head,
        `${row.path}/${filename}`,
      );
      const dir = renamed ? canonicalTableDirForFile(renamed, filename) : null;
      if (dir) candidates.add(dir);
    }
  }
  for (const dir of candidates) {
    const snapshot = await readTableAtSafe(repo, head, dir, {
      trackedFiles: snapshotFiles,
    });
    if (snapshot?.schema.id === tableId) {
      return { dir, slug: slugForTableDir(dir), snapshot };
    }
  }
  const discovered = await discoverTableDirById(
    repo,
    head,
    tableId,
    snapshotFiles,
  );
  if (discovered) {
    const snapshot = await readTableAtSafe(repo, head, discovered, {
      trackedFiles: snapshotFiles,
    });
    if (snapshot?.schema.id === tableId) {
      return {
        dir: discovered,
        slug: slugForTableDir(discovered),
        snapshot,
      };
    }
  }
  return null;
}

async function tableProjectionState(db: Db, located: LocatedTable) {
  const [lastEditedBy] = await resolveAttribution(db, [located.snapshot.entry]);
  return {
    lastEditedBy,
    lastEditedById: lastEditedBy?.id ?? null,
    ...machineEditorColumns(machineRefOf(lastEditedBy)),
    lastEditedByName: located.snapshot.entry.authorName,
    lastEditedAt: located.snapshot.entry.date,
  };
}

function tableProjectionMatches(
  row: DataTable | null,
  located: LocatedTable,
  state: Awaited<ReturnType<typeof tableProjectionState>>,
): boolean {
  return (
    row?.path === located.dir &&
    row.slug === located.slug &&
    row.title === located.snapshot.schema.title &&
    JSON.stringify(normalizeAppearance(row.appearance)) ===
      JSON.stringify(normalizeAppearance(located.snapshot.schema.appearance)) &&
    row.rowCount === located.snapshot.rows.length &&
    row.headCommitSha === located.snapshot.entry.sha &&
    row.lastEditedById === state.lastEditedById &&
    row.lastEditedByProjectKeyId === state.lastEditedByProjectKeyId &&
    row.lastEditedByMachineKind === state.lastEditedByMachineKind &&
    row.lastEditedByMachineId === state.lastEditedByMachineId &&
    row.lastEditedByName === state.lastEditedByName &&
    row.lastEditedAt.getTime() === state.lastEditedAt.getTime() &&
    row.createdAt.getTime() ===
      new Date(located.snapshot.schema.created).getTime()
  );
}

type TableProjectionData = {
  appearance: Prisma.InputJsonValue | typeof Prisma.DbNull;
  path: string;
  slug: string;
  title: string;
  rowCount: number;
  headCommitSha: string;
  lastEditedById: string | null;
  lastEditedByProjectKeyId?: string | null;
  lastEditedByMachineKind?: string | null;
  lastEditedByMachineId?: string | null;
  lastEditedByName?: string | null;
  lastEditedAt: Date;
  createdAt: Date;
};

class TableProjectionOwnershipError extends Error {
  constructor(tableId: string, projectId: string, ownerProjectId: string) {
    super(
      `Table ${tableId} belongs to project ${ownerProjectId}, not ${projectId}`,
    );
    this.name = "TableProjectionOwnershipError";
  }
}

async function upsertOwnedTableProjection(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    projectId: string;
    data: TableProjectionData;
  },
): Promise<void> {
  // Rows are derived and can be rebuilt; the item's link is what survives.
  const sourceItem = await tx.wikiInputItem.findFirst({
    where: { projectId: input.projectId, sourceTableId: input.id },
    select: { id: true },
  });
  const data = { ...input.data, wikiSourceItemId: sourceItem?.id ?? null };
  const updated = await tx.dataTable.updateMany({
    where: { id: input.id, projectId: input.projectId },
    data,
  });
  if (updated.count === 1) return;

  await tx.dataTable.createMany({
    data: [{ id: input.id, projectId: input.projectId, ...data }],
    skipDuplicates: true,
  });
  const converged = await tx.dataTable.updateMany({
    where: { id: input.id, projectId: input.projectId },
    data,
  });
  if (converged.count === 1) return;

  const existing = await tx.dataTable.findUnique({
    where: { id: input.id },
    select: { projectId: true },
  });
  if (existing && existing.projectId !== input.projectId) {
    throw new TableProjectionOwnershipError(
      input.id,
      input.projectId,
      existing.projectId,
    );
  }
  throw new Error(`DataTable projection did not converge for ${input.id}`);
}

function logTableProjectionFailure(input: {
  projectId: string;
  tableId: string;
  headCommitSha: string;
  error: unknown;
}): void {
  const reference = captureError({
    event: "content.projection.failed",
    message: "table projection failed after git commit",
    error: input.error,
    projectId: input.projectId,
    details: {
      kind: "table",
      tableId: input.tableId,
      headCommitSha: input.headCommitSha,
    },
  });
  console.error(
    `DataTable projection failed after git commit (ref ${reference ?? "none"})`,
    { projectId: input.projectId, tableId: input.tableId },
  );
}

async function repairTableProjection(
  db: PrismaClient,
  projectId: string,
  located: LocatedTable,
  state: Awaited<ReturnType<typeof tableProjectionState>>,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await upsertOwnedTableProjection(tx, {
      id: located.snapshot.schema.id,
      projectId,
      data: {
        appearance:
          normalizeAppearance(located.snapshot.schema.appearance) ??
          Prisma.DbNull,
        path: located.dir,
        slug: located.slug,
        title: located.snapshot.schema.title,
        rowCount: located.snapshot.rows.length,
        headCommitSha: located.snapshot.entry.sha,
        lastEditedById: state.lastEditedById,
        lastEditedByProjectKeyId: state.lastEditedByProjectKeyId,
        lastEditedByMachineKind: state.lastEditedByMachineKind,
        lastEditedByMachineId: state.lastEditedByMachineId,
        lastEditedByName: state.lastEditedByName,
        lastEditedAt: state.lastEditedAt,
        createdAt: new Date(located.snapshot.schema.created),
      },
    });
  });
}

export async function repairTableProjectionInRepo(
  db: PrismaClient,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  try {
    const { located } = await requireCurrentTable(db, repo, projectId, tableId);
    await repairTableProjection(
      db,
      projectId,
      located,
      await tableProjectionState(db, located),
    );
  } catch (error) {
    if (options.throwOnError) throw error;
    logTableProjectionFailure({
      projectId,
      tableId,
      headCommitSha: await repo.resolveHead(),
      error,
    });
  }
}

export type TableTreeLeaf = {
  appearance: Appearance | null;
  id: string;
  title: string;
  slug: string;
  path: string;
  rowCount: number;
  lastEditedAt: Date;
  lastEditedBy: {
    id: string | null;
    name: string;
    email: string;
  } | null;
  machineEditor: MachineEditor | null;
};

export async function reconcileTableTreeAtHead(
  db: PrismaClient,
  repo: ProjectRepoReader,
  projectId: string,
  head: string,
): Promise<TableTreeLeaf[]> {
  const [rows, trackedFiles] = await Promise.all([
    db.dataTable.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
      include: {
        lastEditedBy: { select: { id: true, name: true, email: true } },
      },
    }),
    repo.listTrackedFiles(head),
  ]);
  const tables: TableTreeLeaf[] = [];
  const tracked = new Set(trackedFiles);
  for (const row of rows) {
    if (
      tracked.has(`${row.path}/schema.json`) &&
      tracked.has(`${row.path}/data.jsonl`)
    ) {
      const machine = machineEditorFromRow(row);
      tables.push({
        appearance: normalizeAppearance(row.appearance),
        id: row.id,
        title: row.title,
        slug: row.slug,
        path: row.path,
        rowCount: row.rowCount,
        lastEditedAt: row.lastEditedAt,
        lastEditedBy: row.lastEditedBy
          ? {
              id: row.lastEditedBy.id,
              name: row.lastEditedBy.name ?? "",
              email: row.lastEditedBy.email,
            }
          : machine
            ? {
                id: null,
                name: machine.name,
                email:
                  machine.kind === "wikiAgent"
                    ? wikiAgentEmail(machine.id)
                    : `${machine.id}@project-api.invalid`,
              }
            : null,
        machineEditor: machine,
      });
      continue;
    }
    const located = await locateTableAtHead(
      repo,
      head,
      row.id,
      row,
      trackedFiles,
    );
    if (!located) continue;
    const state = await tableProjectionState(db, located);
    if (!tableProjectionMatches(row, located, state)) {
      try {
        await repairTableProjection(db, projectId, located, state);
      } catch (error) {
        logTableProjectionFailure({
          projectId,
          tableId: located.snapshot.schema.id,
          headCommitSha: located.snapshot.entry.sha,
          error,
        });
      }
    }
    tables.push({
      appearance: normalizeAppearance(located.snapshot.schema.appearance),
      id: located.snapshot.schema.id,
      title: located.snapshot.schema.title,
      slug: located.slug,
      path: located.dir,
      rowCount: located.snapshot.rows.length,
      lastEditedAt: state.lastEditedAt,
      lastEditedBy: state.lastEditedBy
        ? {
            id: state.lastEditedBy.id,
            name: state.lastEditedBy.name ?? "",
            email: state.lastEditedBy.email,
          }
        : null,
      machineEditor: machineEditorOf(state.lastEditedBy),
    });
  }
  return tables.sort((left, right) => left.path.localeCompare(right.path));
}

async function nextAvailableTableSlug(
  db: Db,
  repo: ProjectRepoWriter,
  projectId: string,
  title: string,
  folderPath: string[],
  excludeTableId?: string,
  excludeCurrentDir?: string,
): Promise<{ slug: string; dir: string }> {
  const base = slugify(title);
  const excluded = excludeTableId
    ? await db.dataTable.findFirst({
        where: { id: excludeTableId, projectId },
        select: { path: true },
      })
    : null;
  const excludedPath = excludeCurrentDir ?? excluded?.path;
  const ownHistoryDirs = new Set<string>();
  if (excludedPath) {
    for (let skip = 0; skip < 1000; skip += 100) {
      const entries = await tableLogForDir(repo, excludedPath, {
        skip,
        limit: 100,
      });
      for (const entry of entries) {
        ownHistoryDirs.add(entry.dirAtSha);
      }
      if (entries.length < 100) break;
    }
  }
  const tracked = await repo.listTrackedFiles();
  const historicalDirs = new Set(
    (await repo.listHistoricalPaths(TABLES_ROOT)).map((file) =>
      file.split("/").slice(0, -1).join("/"),
    ),
  );
  for (let index = 1; index < 1000; index++) {
    const suffix = index === 1 ? "" : `-${index}`;
    const stem = base.slice(0, 80 - suffix.length).replace(/-+$/g, "");
    const slug = `${stem}${suffix}`;
    const dir = tableDirPath(folderPath, slug);
    const inIndex = await db.dataTable.findFirst({
      where: {
        projectId,
        slug,
        ...(excludeTableId ? { id: { not: excludeTableId } } : {}),
      },
      select: { id: true },
    });
    const isCurrentSelfDir = excludedPath === dir;
    const isOwnHistoryDir = isCurrentSelfDir || ownHistoryDirs.has(dir);
    const trackedCollision = tracked.some((file) => file.startsWith(`${dir}/`));
    const inWorktree = await repo.fileExistsInWorktree(dir);
    const inHistory = historicalDirs.has(dir);
    if (
      !inIndex &&
      (!trackedCollision || isCurrentSelfDir) &&
      (!inWorktree || isCurrentSelfDir) &&
      (!inHistory || isOwnHistoryDir)
    ) {
      return { slug, dir };
    }
  }
  throw new CoreError("INTERNAL_SERVER_ERROR", "no available slug");
}

type PreparedTableWrite = {
  id: string;
  projectId: string;
  dir: string;
  slug: string;
  schema: SchemaFile;
  rows: TableRow[];
  oldDir: string | null;
  create: boolean;
  actorId: string | null;
  actorMachine?: MachineEditorRef | null;
  actorName?: string | null;
  createdAt: Date;
};

type TableWriteMetadata = {
  operation: "create" | "update" | "restore";
  sourceCommitSha?: string;
  merged?: boolean;
  /** Stable audit identifier recorded as a Weaver-Operation-Id commit trailer. */
  operationId?: string;
  /** Durable MCP request identity used to validate crash recovery. */
  mcpRequestHash?: string;
  mcpToolName?: string;
  apiRequestHash?: string;
  apiOperation?: string;
  /** Assistant run that produced the change, as a Weaver-Run-Id commit trailer. */
  runId?: string;
  /** Source writer only: the wiki agent's recovery key and input trailer. */
  wikiRequestHash?: string;
  wikiInputId?: string;
  /** Runs under the project lock immediately before the commit; a throw aborts it. */
  beforeCommit?: () => Promise<void>;
};

/** Audit trailers a restore may carry, so MCP replay can recognise its own commit. */
export type TableWriteAudit = Pick<
  TableWriteMetadata,
  | "operationId"
  | "mcpRequestHash"
  | "mcpToolName"
  | "runId"
  | "apiRequestHash"
  | "apiOperation"
>;

type SerializedTableWrite = {
  schemaText: string;
  dataText: string;
};

function tableCommitMessage(
  metadata: TableWriteMetadata,
  dir: string,
  oldDir: string | null,
): string {
  const moved = oldDir && oldDir !== dir ? ` (was ${oldDir})` : "";
  const from = metadata.sourceCommitSha
    ? ` (from ${metadata.sourceCommitSha.slice(0, 7)})`
    : "";
  const merged = metadata.merged ? " (merged)" : "";
  return `${metadata.operation}: ${dir}${moved}${from}${merged}`;
}

function serializeTableWrite(
  schema: SchemaFile,
  rows: TableRow[],
): SerializedTableWrite {
  const schemaText = serializeSchemaFile(schema);
  const dataText = serializeRows(schema.columns, rows);
  if (Buffer.byteLength(schemaText, "utf8") > MAX_SCHEMA_FILE_BYTES) {
    throw new TablePayloadError("table schema too large");
  }
  if (Buffer.byteLength(dataText, "utf8") > MAX_DATA_FILE_BYTES) {
    throw new TablePayloadError(LARGE_TABLE_HINT);
  }
  return { schemaText, dataText };
}

function assertInputByteBudget(
  title: string,
  columns: TableColumn[],
  rows: TableRow[],
): void {
  const schemaProbe = serializeSchemaFile({
    id: "00000000-0000-4000-8000-000000000000",
    title,
    sourceOfTruth: "git",
    columns,
    created: "2000-01-01T00:00:00.000Z",
    updated: "2000-01-01T00:00:00.000Z",
  });
  if (Buffer.byteLength(schemaProbe, "utf8") > MAX_SCHEMA_FILE_BYTES) {
    throw new TablePayloadError("table schema too large");
  }
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes > MAX_DATA_FILE_BYTES) {
      throw new TablePayloadError(LARGE_TABLE_HINT);
    }
  }
}

async function updateTableProjection(
  db: PrismaClient,
  repo: ProjectRepoReader,
  prepared: PreparedTableWrite & { sha: string },
): Promise<void> {
  try {
    const committedAt = await repo.commitDate(prepared.sha);
    await db.$transaction(async (tx) => {
      await upsertOwnedTableProjection(tx, {
        id: prepared.id,
        projectId: prepared.projectId,
        data: {
          appearance:
            normalizeAppearance(prepared.schema.appearance) ?? Prisma.DbNull,
          path: prepared.dir,
          slug: prepared.slug,
          title: prepared.schema.title,
          rowCount: prepared.rows.length,
          headCommitSha: prepared.sha,
          lastEditedById: prepared.actorId,
          ...machineEditorColumns(prepared.actorMachine ?? null),
          lastEditedByName: prepared.actorName ?? null,
          lastEditedAt: committedAt,
          createdAt: prepared.createdAt,
        },
      });
    });
  } catch (error) {
    logTableProjectionFailure({
      projectId: prepared.projectId,
      tableId: prepared.id,
      headCommitSha: prepared.sha,
      error,
    });
  }
}

async function commitTableWrite(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  prepared: PreparedTableWrite,
  actor: ContentWriteActor,
  metadata: TableWriteMetadata,
  serialized = serializeTableWrite(prepared.schema, prepared.rows),
): Promise<TableWriteResult> {
  if (prepared.oldDir && prepared.oldDir !== prepared.dir) {
    await repo.mv(prepared.oldDir, prepared.dir);
  }
  await repo.writeFileAtomic(
    `${prepared.dir}/schema.json`,
    serialized.schemaText,
  );
  await repo.writeFileAtomic(`${prepared.dir}/data.jsonl`, serialized.dataText);
  const sha = await repo.commitAll(
    tableCommitMessage(metadata, prepared.dir, prepared.oldDir),
    author(actor),
    {
      operationId: metadata.operationId,
      mcpRequestHash: metadata.mcpRequestHash,
      mcpToolName: metadata.mcpToolName,
      apiRequestHash: metadata.apiRequestHash,
      apiOperation: metadata.apiOperation,
      runId: metadata.runId,
      wikiRequestHash: metadata.wikiRequestHash,
      wikiInputId: metadata.wikiInputId,
      beforeCommit: metadata.beforeCommit,
    },
  );
  await updateTableProjection(db, repo, { ...prepared, sha });
  await enqueueTableChanged({
    projectId: prepared.projectId,
    tableId: prepared.id,
    sourceCommitSha: sha,
    pathAtSha: prepared.dir,
  });
  return {
    id: prepared.id,
    path: prepared.dir,
    slug: prepared.slug,
    title: prepared.schema.title,
    columns: prepared.schema.columns,
    rows: prepared.rows,
    headCommitSha: sha,
  };
}

type TableWriteRequest =
  | {
      kind: "create";
      id: string;
      folderPath: string[];
      title: string;
      columns: TableColumn[];
      rows: TableRow[];
      createdAt: string;
      appearance?: Appearance;
    }
  | {
      kind: "update";
      tableId: string;
      baseCommitSha: string;
      title?: string;
      columns: TableColumn[];
      rows: TableRow[];
    };

export type TableWriteRequestInput = TableWriteRequest;

function nextUpdatedTimestamp(previous: string): string {
  return new Date(
    Math.max(Date.now(), new Date(previous).getTime() + 1),
  ).toISOString();
}

function throwPostMergePayloadConflict(
  error: unknown,
  headCommitSha: string,
): never {
  if (error instanceof TablePayloadError) {
    throw new CoreError("CONFLICT", "Table changed since you loaded it", {
      headCommitSha,
    });
  }
  throw error;
}

export async function writeTableInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  projectId: string,
  request: TableWriteRequest,
  actor: ContentWriteActor,
  metadata: TableWriteMetadata,
): Promise<TableWriteResult> {
  if (request.kind === "create") {
    try {
      assertSafeSegments(request.folderPath);
    } catch {
      throw new CoreError("BAD_REQUEST", "invalid folder path");
    }
    assertInputByteBudget(request.title, request.columns, request.rows);
    assertValidTitle(request.title);
    assertValidTableData(request.columns, request.rows);
    if (request.folderPath.length > 0) {
      const folderRel = [TABLES_ROOT, ...request.folderPath].join("/");
      if (!(await repo.fileExistsInWorktree(folderRel))) {
        throw folderNotFound("folderPath");
      }
    }
    const { slug, dir } = await nextAvailableTableSlug(
      db,
      repo,
      projectId,
      request.title,
      request.folderPath,
    );
    const schema: SchemaFile = {
      id: request.id,
      title: request.title,
      sourceOfTruth: "git",
      columns: request.columns,
      created: request.createdAt,
      updated: request.createdAt,
      ...(request.appearance ? { appearance: request.appearance } : {}),
    };
    return commitTableWrite(
      db,
      repo,
      {
        id: request.id,
        projectId,
        dir,
        slug,
        schema,
        rows: request.rows,
        oldDir: null,
        create: true,
        actorId: contentUserId(actor),
        actorMachine: machineIdentity(actor),
        actorName: documentAuthorForContent(actor).name,
        createdAt: new Date(request.createdAt),
      },
      actor,
      metadata,
    );
  }

  assertInputByteBudget(request.title ?? "", request.columns, request.rows);
  const { located } = await requireCurrentTable(
    db,
    repo,
    projectId,
    request.tableId,
  );
  assertValidTableData(request.columns, request.rows);
  const current = located.snapshot;
  let title = request.title ?? current.schema.title;
  let columns = request.columns;
  let rows = request.rows;
  let merged = false;
  if (current.entry.sha !== request.baseCommitSha) {
    const baseDir = await tableDirAtCommit(
      repo,
      located.dir,
      request.tableId,
      request.baseCommitSha,
      await repo.resolveHead(),
    );
    const base = baseDir
      ? await readTableAtSafe(repo, request.baseCommitSha, baseDir)
      : null;
    if (base?.schema.id !== request.tableId) {
      throw new CoreError("CONFLICT", "Base version not found", {
        headCommitSha: current.entry.sha,
      });
    }
    const result = mergeTables(
      {
        title: base.schema.title,
        columns: base.schema.columns,
        rows: base.rows,
      },
      {
        title: current.schema.title,
        columns: current.schema.columns,
        rows: current.rows,
      },
      {
        title,
        columns,
        rows,
      } satisfies TableData,
    );
    if (!result.ok) {
      throw new CoreError("CONFLICT", "Table changed since you loaded it", {
        conflicts: result.conflicts,
        headCommitSha: current.entry.sha,
      });
    }
    title = result.merged.title;
    columns = result.merged.columns;
    rows = result.merged.rows;
    merged = true;
  }
  try {
    assertValidTitle(title);
    assertValidTableData(columns, rows);
  } catch (error) {
    if (merged) throwPostMergePayloadConflict(error, current.entry.sha);
    throw error;
  }
  let dir = located.dir;
  let slug = located.slug;
  if (
    title !== current.schema.title &&
    slugify(title) !== slugify(current.schema.title)
  ) {
    const next = await nextAvailableTableSlug(
      db,
      repo,
      projectId,
      title,
      folderPathOfTableDir(located.dir),
      current.schema.id,
      located.dir,
    );
    dir = next.dir;
    slug = next.slug;
  }
  const schema: SchemaFile = {
    id: current.schema.id,
    title,
    sourceOfTruth: "git",
    columns,
    created: current.schema.created,
    updated: nextUpdatedTimestamp(current.schema.updated),
    ...(current.schema.appearance
      ? { appearance: current.schema.appearance }
      : {}),
  };
  let serialized: SerializedTableWrite | undefined;
  if (merged) {
    try {
      serialized = serializeTableWrite(schema, rows);
    } catch (error) {
      throwPostMergePayloadConflict(error, current.entry.sha);
    }
  }
  return commitTableWrite(
    db,
    repo,
    {
      id: current.schema.id,
      projectId,
      dir,
      slug,
      schema,
      rows,
      oldDir: located.dir,
      create: false,
      actorId: contentUserId(actor),
      actorMachine: machineIdentity(actor),
      actorName: documentAuthorForContent(actor).name,
      createdAt: new Date(current.schema.created),
    },
    actor,
    { ...metadata, merged },
    serialized,
  );
}

export async function createTable(
  db: PrismaClient,
  input: {
    projectId: string;
    folderPath: string[];
    title: string;
    columns?: TableColumn[];
    rows?: TableRow[];
    appearance?: Appearance;
    iconAssets?: AppearanceAsset[];
  },
  actor: EnrichedActor,
): Promise<TableWriteResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const columns = input.columns ?? [
    { id: randomUUID(), name: "Name", type: "text" as const },
  ];
  const rows = input.rows ?? [];
  assertInputByteBudget(input.title, columns, rows);
  const result = await withProjectRepo(input.projectId, async (repo) => {
    await assertProjectRole(db, input.projectId, actor, "Editor");
    return withAppearanceAssetsInRepo(
      repo,
      input.appearance ? [input.appearance] : [],
      input.iconAssets ?? [],
      (writer) =>
        writeTableInRepo(
          db,
          writer,
          input.projectId,
          {
            kind: "create",
            id: randomUUID(),
            folderPath: input.folderPath,
            title: input.title,
            columns,
            rows,
            createdAt: new Date().toISOString(),
            ...(input.appearance ? { appearance: input.appearance } : {}),
          },
          actor,
          { operation: "create" },
        ),
    );
  });
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

export async function getTable(
  db: PrismaClient,
  input: { projectId: string; tableId: string },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const row = await db.dataTable.findFirst({
        where: { id: input.tableId, projectId: input.projectId },
      });
      const head = await repo.resolveHead();
      const located = await locateTableAtHead(repo, head, input.tableId, row);
      if (!located) throw new CoreError("NOT_FOUND");
      const state = await tableProjectionState(db, located);
      if (!tableProjectionMatches(row, located, state)) {
        try {
          await repairTableProjection(db, input.projectId, located, state);
        } catch (error) {
          logTableProjectionFailure({
            projectId: input.projectId,
            tableId: located.snapshot.schema.id,
            headCommitSha: located.snapshot.entry.sha,
            error,
          });
        }
      }
      return {
        appearance: normalizeAppearance(located.snapshot.schema.appearance),
        id: located.snapshot.schema.id,
        path: located.dir,
        slug: located.slug,
        title: located.snapshot.schema.title,
        columns: located.snapshot.schema.columns,
        rows: located.snapshot.rows,
        rowCount: located.snapshot.rows.length,
        baseCommitSha: located.snapshot.entry.sha,
        snapshotCommitSha: head,
        lastEditedAt: state.lastEditedAt,
        lastEditedById: state.lastEditedById,
        lastEditedByProjectKeyId: state.lastEditedByProjectKeyId,
        lastEditedByMachineKind: state.lastEditedByMachineKind,
        lastEditedByMachineId: state.lastEditedByMachineId,
        lastEditedByName: state.lastEditedByName,
        lastEditedBy: state.lastEditedBy,
      };
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

/** Read-only pinned table read (concept §4.1); repairs no projection. */
export async function getTableAtSnapshot(
  db: PrismaClient,
  input: { projectId: string; tableId: string; atCommitSha?: string },
  actor: ProjectActor,
): Promise<{
  id: string;
  path: string;
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  rowCount: number;
  snapshotCommitSha: string;
  baseCommitSha: string;
}> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const snapshotCommitSha = await resolveSnapshotCommit(
        repo,
        input.atCommitSha,
      );
      const { located } = await requireTableAtSnapshot(
        db,
        repo,
        input.projectId,
        input.tableId,
        snapshotCommitSha,
      );
      return {
        id: located.snapshot.schema.id,
        path: located.dir,
        title: located.snapshot.schema.title,
        columns: located.snapshot.schema.columns,
        rows: located.snapshot.rows,
        rowCount: located.snapshot.rows.length,
        snapshotCommitSha,
        baseCommitSha: located.snapshot.entry.sha,
      };
    },
  );
  if (!result) throw new CoreError("NOT_FOUND");
  return result;
}

export async function getTableBacklinks(
  db: PrismaClient,
  input: { projectId: string; tableId: string },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const row = await db.dataTable.findFirst({
    where: { id: input.tableId, projectId: input.projectId },
  });
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const head = await repo.resolveHead();
      let exists = false;
      if (row) {
        const size = await repo.blobSizeAt(head, `${row.path}/schema.json`);
        if (size !== null && size <= MAX_SCHEMA_FILE_BYTES) {
          try {
            exists =
              parseSchemaFile(
                await repo.showFileAt(head, `${row.path}/schema.json`),
              ).id === input.tableId &&
              Boolean(await repo.blobShaAt(head, `${row.path}/data.jsonl`));
          } catch {
            /* Invalid snapshots remain unavailable. */
          }
        }
      }
      if (!exists)
        exists = Boolean(
          await discoverTableDirById(
            repo,
            head,
            input.tableId,
            await repo.listTrackedFiles(head),
          ),
        );
      if (!exists) throw new CoreError("NOT_FOUND");
      return db.document.findMany({
        where: {
          projectId: input.projectId,
          linksTo: {
            some: {
              targetDocumentId: input.tableId,
              targetType: "table",
            },
          },
        },
        select: {
          id: true,
          title: true,
          path: true,
          excerpt: true,
          lastEditedAt: true,
        },
        orderBy: [{ title: "asc" }, { id: "asc" }],
      });
    },
  );
  if (result === null) throw new CoreError("NOT_FOUND");
  return result;
}

export async function saveTable(
  db: PrismaClient,
  input: {
    projectId: string;
    tableId: string;
    baseCommitSha: string;
    title?: string;
    columns: TableColumn[];
    rows: TableRow[];
  },
  actor: EnrichedActor,
): Promise<TableWriteResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  assertInputByteBudget(input.title ?? "", input.columns, input.rows);
  const result = await withProjectRepo(input.projectId, (repo) =>
    writeTableInRepo(
      db,
      repo,
      input.projectId,
      {
        kind: "update",
        tableId: input.tableId,
        baseCommitSha: input.baseCommitSha,
        title: input.title,
        columns: input.columns,
        rows: input.rows,
      },
      actor,
      { operation: "update" },
    ),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

async function requireCurrentTable(
  db: Db,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
): Promise<{ row: DataTable | null; located: LocatedTable }> {
  const head = await repo.resolveHead();
  return requireTableAtSnapshot(db, repo, projectId, tableId, head);
}

/**
 * Read committed table truth through a repository handle the caller already
 * holds. Takes no advisory lock of its own, so it is safe inside
 * `withProjectRepo`; access must be asserted by the caller.
 */
export async function getTableInRepo(
  db: Db,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
  atCommitSha?: string,
): Promise<{
  id: string;
  path: string;
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  baseCommitSha: string;
}> {
  const { located } = atCommitSha
    ? await requireTableAtSnapshot(db, repo, projectId, tableId, atCommitSha)
    : await requireCurrentTable(db, repo, projectId, tableId);
  return {
    id: located.snapshot.schema.id,
    path: located.dir,
    title: located.snapshot.schema.title,
    columns: located.snapshot.schema.columns,
    rows: located.snapshot.rows,
    baseCommitSha: located.snapshot.entry.sha,
  };
}

async function requireTableAtSnapshot(
  db: Db,
  repo: ProjectRepoReader,
  projectId: string,
  tableId: string,
  snapshotSha: string,
): Promise<{ row: DataTable | null; located: LocatedTable }> {
  const row = await db.dataTable.findFirst({
    where: { id: tableId, projectId },
  });
  const located = await locateTableAtHead(repo, snapshotSha, tableId, row);
  if (!located) throw new CoreError("NOT_FOUND");
  return { row, located };
}

async function assertTableFolderDestination(
  repo: ProjectRepoWriter,
  folderPath: string[],
): Promise<void> {
  try {
    assertSafeSegments(folderPath);
  } catch {
    throw new CoreError("BAD_REQUEST", "invalid folder path");
  }
  if (folderPath.length === 0) return;
  const folderRel = [TABLES_ROOT, ...folderPath].join("/");
  if (!(await repo.listWorktreeDirs()).includes(folderRel)) {
    throw folderNotFound("folderPath");
  }
}

async function updateMovedTableProjection(
  db: PrismaClient,
  repo: ProjectRepoReader,
  input: {
    projectId: string;
    located: LocatedTable;
    dir: string;
    slug: string;
    sha: string;
    actorId: string;
  },
): Promise<void> {
  try {
    const lastEditedAt = await repo.commitDate(input.sha);
    await db.$transaction(async (tx) => {
      await upsertOwnedTableProjection(tx, {
        id: input.located.snapshot.schema.id,
        projectId: input.projectId,
        data: {
          appearance:
            normalizeAppearance(input.located.snapshot.schema.appearance) ??
            Prisma.DbNull,
          path: input.dir,
          slug: input.slug,
          title: input.located.snapshot.schema.title,
          rowCount: input.located.snapshot.rows.length,
          headCommitSha: input.sha,
          lastEditedById: input.actorId,
          ...machineEditorColumns(null),
          lastEditedByName: null,
          lastEditedAt,
          createdAt: new Date(input.located.snapshot.schema.created),
        },
      });
    });
  } catch (error) {
    logTableProjectionFailure({
      projectId: input.projectId,
      tableId: input.located.snapshot.schema.id,
      headCommitSha: input.sha,
      error,
    });
  }
}

export async function moveTableInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: { projectId: string; tableId: string; folderPath: string[] },
  actor: EnrichedActor,
  audit: TableWriteAudit = {},
): Promise<TableWriteResult> {
  const { row, located } = await requireCurrentTable(
    db,
    repo,
    input.projectId,
    input.tableId,
  );
  await assertTableFolderDestination(repo, input.folderPath);
  const requestedDir = tableDirPath(input.folderPath, located.slug);
  if (requestedDir === located.dir) {
    const state = await tableProjectionState(db, located);
    if (!tableProjectionMatches(row, located, state)) {
      try {
        await repairTableProjection(db, input.projectId, located, state);
      } catch (error) {
        logTableProjectionFailure({
          projectId: input.projectId,
          tableId: located.snapshot.schema.id,
          headCommitSha: located.snapshot.entry.sha,
          error,
        });
      }
    }
    return {
      id: located.snapshot.schema.id,
      path: located.dir,
      slug: located.slug,
      title: located.snapshot.schema.title,
      columns: located.snapshot.schema.columns,
      rows: located.snapshot.rows,
      headCommitSha: located.snapshot.entry.sha,
    };
  }
  const next = await nextAvailableTableSlug(
    db,
    repo,
    input.projectId,
    located.slug,
    input.folderPath,
    located.snapshot.schema.id,
    located.dir,
  );
  await repo.mv(located.dir, next.dir);
  const sha = await repo.commitAll(
    `move: ${next.dir} (was ${located.dir})`,
    author(actor),
    audit,
  );
  await updateMovedTableProjection(db, repo, {
    projectId: input.projectId,
    located,
    dir: next.dir,
    slug: next.slug,
    sha,
    actorId: actor.userId,
  });
  await enqueueTableChanged({
    projectId: input.projectId,
    tableId: located.snapshot.schema.id,
    sourceCommitSha: sha,
    pathAtSha: next.dir,
  });
  return {
    id: located.snapshot.schema.id,
    path: next.dir,
    slug: next.slug,
    title: located.snapshot.schema.title,
    columns: located.snapshot.schema.columns,
    rows: located.snapshot.rows,
    headCommitSha: sha,
  };
}

export async function moveTable(
  db: PrismaClient,
  input: { projectId: string; tableId: string; folderPath: string[] },
  actor: EnrichedActor,
): Promise<TableWriteResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    moveTableInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}

async function deleteTableProjection(
  db: PrismaClient,
  input: { projectId: string; tableId: string; sha: string },
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await tx.dataTable.deleteMany({
        where: { id: input.tableId, projectId: input.projectId },
      });
    });
  } catch (error) {
    logTableProjectionFailure({
      projectId: input.projectId,
      tableId: input.tableId,
      headCommitSha: input.sha,
      error,
    });
  }
}

export type TableDeleteResult = {
  id: string;
  path: string;
  headCommitSha: string;
};

export async function deleteTableInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: { projectId: string; tableId: string; expectedHeadCommitSha: string },
  actor: ContentWriteActor,
  audit: TableWriteAudit = {},
): Promise<TableDeleteResult> {
  const { located } = await requireCurrentTable(
    db,
    repo,
    input.projectId,
    input.tableId,
  );
  if (input.expectedHeadCommitSha !== located.snapshot.entry.sha) {
    throw new CoreError(
      "CONFLICT",
      "The table changed. Reload and try deleting again.",
      { headCommitSha: located.snapshot.entry.sha },
    );
  }
  await repo.rmDir(located.dir);
  const sha = await repo.commitAll(
    `delete: ${located.dir}`,
    author(actor),
    audit,
  );
  await deleteTableProjection(db, {
    projectId: input.projectId,
    tableId: located.snapshot.schema.id,
    sha,
  });
  await enqueueContentDeleted({
    projectId: input.projectId,
    sourceType: "table",
    sourceId: located.snapshot.schema.id,
    sourceCommitSha: sha,
  });
  return {
    id: located.snapshot.schema.id,
    path: located.dir,
    headCommitSha: sha,
  };
}

export async function deleteTable(
  db: PrismaClient,
  input: { projectId: string; tableId: string; expectedHeadCommitSha: string },
  actor: EnrichedActor,
): Promise<void> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  await withProjectRepo(input.projectId, (repo) =>
    deleteTableInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
}

export async function listTables(
  db: PrismaClient,
  input: {
    projectId: string;
    page: number;
    pageSize: number;
    search?: string;
    folderPath?: string[];
    sort: "title" | "lastEditedAt";
    dir: "asc" | "desc";
  },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  if (input.folderPath) {
    try {
      assertSafeSegments(input.folderPath);
    } catch {
      throw new CoreError("BAD_REQUEST", "invalid folder path");
    }
  }
  const folderPrefix = input.folderPath?.length
    ? `${TABLES_ROOT}/${input.folderPath.join("/")}/`
    : undefined;
  const where: Prisma.DataTableWhereInput = {
    projectId: input.projectId,
    ...(folderPrefix ? { path: { startsWith: folderPrefix } } : {}),
    ...(input.search
      ? { title: { contains: input.search, mode: "insensitive" as const } }
      : {}),
  };
  const total = await db.dataTable.count({ where });
  const orderBy: Prisma.DataTableOrderByWithRelationInput[] = [
    { [input.sort]: input.dir },
    { id: "asc" },
  ];
  const items = await db.dataTable.findMany({
    where,
    orderBy,
    ...(input.pageSize > 0
      ? { skip: (input.page - 1) * input.pageSize, take: input.pageSize }
      : {}),
    select: {
      id: true,
      title: true,
      slug: true,
      path: true,
      rowCount: true,
      appearance: true,
      headCommitSha: true,
      lastEditedAt: true,
      lastEditedBy: { select: { id: true, name: true, email: true } },
      lastEditedByMachineKind: true,
      lastEditedByMachineId: true,
      lastEditedByName: true,
    },
  });
  const pageSize = input.pageSize > 0 ? input.pageSize : total;
  return {
    items: items.map(
      ({
        lastEditedByMachineKind,
        lastEditedByMachineId,
        lastEditedByName,
        ...item
      }) => ({
        ...item,
        appearance: normalizeAppearance(item.appearance),
        machineEditor: machineEditorFromRow({
          lastEditedByMachineKind,
          lastEditedByMachineId,
          lastEditedByName,
        }),
      }),
    ),
    total,
    page: input.page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 1,
  };
}

export async function rebuildTableIndex(
  db: PrismaClient,
  input: { projectId: string },
  actor: ProjectActor,
): Promise<{
  indexed: number;
  skipped: Array<{ path: string; reason: string }>;
}> {
  await assertProjectRole(db, input.projectId, actor, "Maintainer");
  const report = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const head = await repo.resolveHead();
      const trackedFiles = await repo.listTrackedFiles(head);
      const tableDirs = [
        ...new Set(
          trackedFiles
            .map(candidateTableDirForTrackedFile)
            .filter((path): path is string => path !== null),
        ),
      ].sort();
      const skipped: Array<{ path: string; reason: string }> = [];
      const candidates: Array<{
        id: string;
        path: string;
        slug: string;
        title: string;
        rowCount: number;
        appearance: Appearance | null;
        head: TableLogEntry;
        createdAt: Date;
      }> = [];

      for (const path of tableDirs) {
        try {
          const schemaPath = `${path}/schema.json`;
          if (canonicalTableDirForFile(schemaPath, "schema.json") !== path) {
            throw new Error("invalid table path");
          }
          const files = trackedFiles.filter((file) =>
            file.startsWith(`${path}/`),
          );
          if (!hasExactTableLayout(files, path)) {
            throw new Error(
              "table directory must contain exactly schema.json and data.jsonl",
            );
          }
          const snapshot = await readTableAt(repo, head, path, {
            trackedFiles,
          });
          if (!snapshot) throw new Error("schema.json is missing");
          candidates.push({
            appearance: normalizeAppearance(snapshot.schema.appearance),
            id: snapshot.schema.id,
            path,
            slug: slugForTableDir(path),
            title: snapshot.schema.title,
            rowCount: snapshot.rows.length,
            head: snapshot.entry,
            createdAt: new Date(snapshot.schema.created),
          });
        } catch (error) {
          skipped.push({
            path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const existing =
        candidates.length > 0
          ? await db.dataTable.findMany({
              where: {
                id: { in: candidates.map((candidate) => candidate.id) },
              },
              select: { id: true, projectId: true },
            })
          : [];
      const ownerById = new Map(existing.map((row) => [row.id, row.projectId]));
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      const seenSlugs = new Set<string>();
      const rows = candidates.filter((candidate) => {
        if (seenIds.has(candidate.id)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate id ${candidate.id} (first table by path order wins)`,
          });
          return false;
        }
        seenIds.add(candidate.id);
        const ownerProjectId = ownerById.get(candidate.id);
        if (ownerProjectId && ownerProjectId !== input.projectId) {
          skipped.push({
            path: candidate.path,
            reason: `id ${candidate.id} belongs to another project`,
          });
          return false;
        }
        if (seenPaths.has(candidate.path)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate path ${candidate.path} (first table by path order wins)`,
          });
          return false;
        }
        if (seenSlugs.has(candidate.slug)) {
          skipped.push({
            path: candidate.path,
            reason: `duplicate slug ${candidate.slug} (first table by path order wins)`,
          });
          return false;
        }
        seenPaths.add(candidate.path);
        seenSlugs.add(candidate.slug);
        return true;
      });
      const attribution = await resolveAttribution(
        db,
        rows.map((row) => row.head),
      );

      let indexed = 0;
      await db.$transaction(async (tx) => {
        const sourceItems = new Map(
          (
            await tx.wikiInputItem.findMany({
              where: {
                projectId: input.projectId,
                sourceTableId: { in: rows.map((row) => row.id) },
              },
              select: { id: true, sourceTableId: true },
            })
          ).map((item) => [item.sourceTableId!, item.id]),
        );
        await tx.dataTable.deleteMany({
          where: { projectId: input.projectId },
        });
        for (const [index, row] of rows.entries()) {
          const created = await tx.dataTable.createMany({
            data: [
              {
                appearance: row.appearance ?? Prisma.DbNull,
                id: row.id,
                projectId: input.projectId,
                path: row.path,
                slug: row.slug,
                title: row.title,
                rowCount: row.rowCount,
                headCommitSha: row.head.sha,
                lastEditedById: attribution[index]?.id ?? null,
                ...machineEditorColumns(machineRefOf(attribution[index])),
                lastEditedByName: row.head.authorName,
                lastEditedAt: row.head.date,
                createdAt: row.createdAt,
                wikiSourceItemId: sourceItems.get(row.id) ?? null,
              },
            ],
            skipDuplicates: true,
          });
          if (created.count === 1) {
            indexed += 1;
            continue;
          }
          const owner = await tx.dataTable.findUnique({
            where: { id: row.id },
            select: { projectId: true },
          });
          skipped.push({
            path: row.path,
            reason:
              owner && owner.projectId !== input.projectId
                ? `id ${row.id} belongs to another project`
                : `projection conflict for id ${row.id}, path ${row.path}, or slug ${row.slug}`,
          });
        }
      });
      return { indexed, skipped };
    },
  );
  const result = report ?? {
    indexed: 0,
    skipped: [{ path: "", reason: "project repository not found" }],
  };
  await enqueueProjectReconcile(input.projectId);
  return result;
}

export async function getTableHistory(
  db: Db,
  input: { projectId: string; tableId: string; offset: number; limit: number },
  actor: ProjectActor,
) {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  if (
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 1000 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new CoreError("BAD_REQUEST", "invalid table history pagination");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const snapshotSha = await repo.resolveHead();
      const { located } = await requireTableAtSnapshot(
        db,
        repo,
        input.projectId,
        input.tableId,
        snapshotSha,
      );
      const raw = await validatedTableHistory(
        repo,
        located.dir,
        input.tableId,
        input.offset + input.limit + 1,
        snapshotSha,
      );
      const entries = raw.slice(input.offset, input.offset + input.limit);
      const attribution = await resolveAttribution(db, entries);
      return {
        hasMore: raw.length > input.offset + input.limit,
        entries: entries.map((entry, index) => {
          const resolved = attribution[index];
          return {
            sha: entry.sha,
            pathAtSha: entry.dirAtSha,
            authorName: entry.authorName,
            userId: resolved?.id ?? null,
            userName: resolved ? (resolved.name ?? resolved.email) : null,
            projectKeyId:
              resolved?.kind === "machine" &&
              resolved.machineKind === "projectApiKey"
                ? resolved.machineId
                : null,
            machineEditor: machineEditorOf(resolved),
            date: entry.date,
            message: entry.message,
          };
        }),
      };
    },
  );
  if (result === null) throw new CoreError("NOT_FOUND");
  return result;
}

export async function getTableDiff(
  db: Db,
  input: { projectId: string; tableId: string; fromSha: string; toSha: string },
  actor: ProjectActor,
): Promise<TableDiff | { tooLarge: true }> {
  await assertProjectRole(db, input.projectId, actor, "Viewer");
  const result = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      const snapshotSha = await repo.resolveHead();
      const { located } = await requireTableAtSnapshot(
        db,
        repo,
        input.projectId,
        input.tableId,
        snapshotSha,
      );
      const [fromDir, toDir] = await Promise.all([
        tableDirAtCommit(
          repo,
          located.dir,
          input.tableId,
          input.fromSha,
          snapshotSha,
        ),
        tableDirAtCommit(
          repo,
          located.dir,
          input.tableId,
          input.toSha,
          snapshotSha,
        ),
      ]);
      if (!fromDir || !toDir) {
        throw new CoreError("NOT_FOUND", "version not found");
      }
      const [from, to] = await Promise.all([
        readTableAtSafe(repo, input.fromSha, fromDir, {
          allowOversizedDiff: true,
        }),
        readTableAtSafe(repo, input.toSha, toDir, {
          allowOversizedDiff: true,
        }),
      ]);
      if (
        !from ||
        !to ||
        from.schema.id !== input.tableId ||
        to.schema.id !== input.tableId
      ) {
        throw new CoreError("NOT_FOUND", "version not found");
      }
      if (
        exceedsTableDiffCaps(from.schema.columns, from.rows) ||
        exceedsTableDiffCaps(to.schema.columns, to.rows)
      ) {
        return { tooLarge: true as const };
      }
      return diffTables(
        {
          title: from.schema.title,
          columns: from.schema.columns,
          rows: from.rows,
        },
        {
          title: to.schema.title,
          columns: to.schema.columns,
          rows: to.rows,
        },
      );
    },
  );
  if (result === null) throw new CoreError("NOT_FOUND");
  return result;
}

export async function restoreTableInRepo(
  db: PrismaClient,
  repo: ProjectRepoWriter,
  input: {
    projectId: string;
    tableId: string;
    sha: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
  audit: TableWriteAudit = {},
): Promise<TableWriteResult> {
  const { located } = await requireCurrentTable(
    db,
    repo,
    input.projectId,
    input.tableId,
  );
  if (input.expectedHeadCommitSha !== located.snapshot.entry.sha)
    throw new CoreError(
      "CONFLICT",
      "The table changed. Reload before restoring.",
      { headCommitSha: located.snapshot.entry.sha },
    );
  const restoredDir = await tableDirAtCommit(
    repo,
    located.dir,
    input.tableId,
    input.sha,
    await repo.resolveHead(),
  );
  const restored = restoredDir
    ? await readTableAtSafe(repo, input.sha, restoredDir, {
        allowOversizedDiff: true,
      })
    : null;
  if (restored?.schema.id !== input.tableId) {
    throw new CoreError("NOT_FOUND", "version not found");
  }
  if (
    restored.rows.length > MAX_TABLE_ROWS ||
    restored.schema.columns.length > MAX_TABLE_COLUMNS
  )
    throw new CoreError(
      "PRECONDITION_FAILED",
      "This table version exceeds the supported row or column limit and cannot be restored.",
    );
  return writeTableInRepo(
    db,
    repo,
    input.projectId,
    {
      kind: "update",
      tableId: input.tableId,
      baseCommitSha: located.snapshot.entry.sha,
      title: restored.schema.title,
      columns: restored.schema.columns,
      rows: restored.rows,
    },
    actor,
    { operation: "restore", sourceCommitSha: input.sha, ...audit },
  );
}

export async function restoreTable(
  db: PrismaClient,
  input: {
    projectId: string;
    tableId: string;
    sha: string;
    expectedHeadCommitSha: string;
  },
  actor: EnrichedActor,
): Promise<TableWriteResult> {
  await assertProjectRole(db, input.projectId, actor, "Editor");
  const result = await withProjectRepo(input.projectId, (repo) =>
    restoreTableInRepo(db, repo, input, actor),
  );
  void notifyProjectContentChanged(db, input.projectId);
  return result;
}
