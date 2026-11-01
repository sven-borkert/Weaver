import type { PrismaClient } from "@weaver/db/client";
import { openProjectRepo } from "@weaver/git-store";
import type { ScopeSnapshot } from "../assistant/scopeSchema";
import { changeSummaryMessage } from "../documents/changeSummaryMessage";
import { CoreError } from "../errors";
import type { ProjectActor } from "../services/projectAccess";
import {
  documentContentText,
  getDiff,
  getDocument,
  listDocuments,
} from "../services/documents";
import {
  projectChangesSince,
  type ProjectChange,
} from "../services/projectActivity";
import { getTable, listTables } from "../services/tables";

export const TASK_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_CONTEXT_WINDOW = 32000;
const PROMPT_OVERHEAD_BYTES = 1024;
const DIGEST_SHARE = 0.4;
const MAX_COMMITS_PER_PROJECT = 200;
const MAX_DIFFED_DOCUMENTS = 40;
const MAX_DIFF_CHARS = 8_000;
const MAX_DOCUMENT_CHARS = 32_000;
const MAX_TABLE_ROWS = 50;
const FIRST_RUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_PAGE = 200;
const BLOCK_SEPARATOR = "\n\n";
const BLOCK_SEPARATOR_BYTES = 2;
const MIN_PARTIAL_BLOCK_BYTES = 256;

export type TaskContextProjectSummary = {
  projectId: string;
  documents: number;
  tables: number;
  commits: number;
};

export type TaskContextSummary = {
  documents: number;
  tables: number;
  commits: number;
  truncated: boolean;
  fallback: "none" | "since_date";
  projects: TaskContextProjectSummary[];
};

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function computeTaskBudget(input: {
  contextWindow: number | null;
  maxOutputTokens: number | null | undefined;
  systemPrompt: string;
  instruction: string;
}): { inputBytes: number; maxOutputTokens: number } {
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = Math.min(
    input.maxOutputTokens ?? TASK_MAX_OUTPUT_TOKENS,
    TASK_MAX_OUTPUT_TOKENS,
    Math.floor(contextWindow / 8),
  );
  const inputBytes =
    contextWindow -
    bytes(input.systemPrompt) -
    bytes(input.instruction) -
    PROMPT_OVERHEAD_BYTES -
    maxOutputTokens;
  if (inputBytes <= 0)
    throw new CoreError(
      "PRECONDITION_FAILED",
      "The routed model's context window is too small for a task run",
    );
  return { inputBytes, maxOutputTokens };
}

export function takeWithinBudget(
  blocks: string[],
  budgetBytes: number,
): { blocks: string[]; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const size = bytes(block) + (kept.length > 0 ? BLOCK_SEPARATOR_BYTES : 0);
    if (used + size > budgetBytes) return { blocks: kept, truncated: true };
    kept.push(block);
    used += size;
  }
  return { blocks: kept, truncated: false };
}

export type TaggedBlock = {
  kind: "document" | "table";
  text: string;
  truncated: boolean;
};

type ProjectBlock = TaggedBlock & { projectId: string };

/** Keeps the fitting prefix, then the head of the first block that does not fit. */
export function fitWithinBudget<T extends { text: string; truncated: boolean }>(
  blocks: T[],
  budgetBytes: number,
): { blocks: T[]; truncated: boolean } {
  const whole = takeWithinBudget(
    blocks.map((block) => block.text),
    budgetBytes,
  );
  const kept = blocks.slice(0, whole.blocks.length);
  const next = blocks[kept.length];
  if (next) {
    const room =
      budgetBytes -
      kept.reduce(
        (total, block) => total + bytes(block.text) + BLOCK_SEPARATOR_BYTES,
        0,
      );
    // A few spare bytes would only hold a heading and the marker.
    const text =
      room >= MIN_PARTIAL_BLOCK_BYTES ? cutToBytes(next.text, room) : "";
    if (text) kept.push({ ...next, text, truncated: true });
  }
  return {
    blocks: kept,
    truncated: whole.truncated || kept.some((block) => block.truncated),
  };
}

/** `fitWithinBudget` keeps an ordered prefix, so the kept blocks count by kind. */
export function selectWithinBudget(
  tagged: TaggedBlock[],
  budgetBytes: number,
): {
  blocks: string[];
  documents: number;
  tables: number;
  truncated: boolean;
} {
  const kept = fitWithinBudget(tagged, budgetBytes);
  const included = kept.blocks;
  return {
    blocks: included.map((block) => block.text),
    documents: included.filter((block) => block.kind === "document").length,
    tables: included.filter((block) => block.kind === "table").length,
    truncated: kept.truncated,
  };
}

const STATUS_WORDS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

export type DigestProject = {
  projectName: string;
  commits: ProjectChange[];
  diffs: Array<{ title: string; lines: string[] }>;
};

export function renderDigest(
  projects: DigestProject[],
  options: { excludeDocumentId: string | null },
): string {
  const parts: string[] = [];
  for (const project of projects) {
    parts.push(`## Changes in ${project.projectName}`);
    if (project.commits.length === 0)
      parts.push("_No changes in this period._");
    for (const commit of project.commits) {
      const docs = commit.documents
        .filter((d) => d.id !== options.excludeDocumentId)
        .map((d) => `${d.title} (${STATUS_WORDS[d.status] ?? d.status})`);
      const tables = commit.tables.map(
        (t) => `${t.title} (${STATUS_WORDS[t.status] ?? t.status})`,
      );
      if (docs.length === 0 && tables.length === 0) continue;
      parts.push(
        `- ${commit.date.toISOString().slice(0, 16).replace("T", " ")} · ${commit.authorName} · "${changeSummaryMessage(commit.message, commit.changeSummary)}"` +
          (docs.length ? ` — documents: ${docs.join(", ")}` : "") +
          (tables.length ? ` — tables: ${tables.join(", ")}` : ""),
      );
    }
    for (const diff of project.diffs) {
      parts.push(`### Diff: ${diff.title}`, "```diff", ...diff.lines, "```");
    }
  }
  return parts.join("\n");
}

/**
 * A rendered cell: table cells hold scalars or a multiselect array of option
 * ids, and a sparse cell is absent.
 */
type SampleCell = string | number | boolean | string[] | null | undefined;

function renderSampleCell(value: SampleCell): string {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function renderTableSample(
  table: {
    title: string;
    columns: Array<{ name: string }>;
    rows: Array<Record<string, SampleCell>>;
  },
  maxRows: number,
): string {
  const header = `| ${table.columns.map((c) => c.name).join(" | ")} |`;
  const rule = `| ${table.columns.map(() => "---").join(" | ")} |`;
  const body = table.rows
    .slice(0, maxRows)
    .map(
      (row) =>
        `| ${table.columns.map((c) => renderSampleCell(row[c.name])).join(" | ")} |`,
    );
  const note =
    table.rows.length > maxRows
      ? `\n_${maxRows} of ${table.rows.length} rows shown._`
      : "";
  return `## Table: ${table.title}\n${header}\n${rule}\n${body.join("\n")}${note}`;
}

const TRUNCATION_MARKER = "\n\n_[truncated]_";

/** Every budget here is UTF-8 bytes, so cut by bytes on whole code points. */
export function cutToBytes(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const room = maxBytes - bytes(TRUNCATION_MARKER);
  if (room <= 0) return "";
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = bytes(char);
    if (used + size > room) break;
    used += size;
    end += char.length;
  }
  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

/** Stored rows key their cells by column id; the sample renders human column names. */
function flattenTableRows(
  columns: Array<{ id: string; name: string }>,
  rows: Array<{ cells: Record<string, SampleCell> }>,
): Array<Record<string, SampleCell>> {
  return rows.map((row) => {
    const flat: Record<string, SampleCell> = {};
    for (const column of columns) flat[column.name] = row.cells[column.id];
    return flat;
  });
}

export async function assembleTaskContext(
  db: PrismaClient,
  actor: ProjectActor,
  input: {
    scope: ScopeSnapshot;
    excludeDocumentId: string | null;
    previousHeads: Record<string, string> | null;
    inputBytes: number;
    now: Date;
    period?: { start: string; end: string };
  },
): Promise<{
  digest: string;
  content: string;
  summary: TaskContextSummary;
  heads: Record<string, string>;
  period: { from: Date | null; to: Date };
}> {
  const sinceDate = input.period
    ? new Date(input.period.start)
    : new Date(input.now.getTime() - FIRST_RUN_WINDOW_MS);
  const heads: Record<string, string> = {};
  const digestProjects: DigestProject[] = [];
  let commits = 0;
  const commitsByProject = new Map<string, number>();
  let truncated = false;
  let fallback: TaskContextSummary["fallback"] = "none";
  let diffBudget = MAX_DIFFED_DOCUMENTS;
  let periodFrom: Date | null = null;

  for (const projectId of input.scope.projectIds) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    const fromSha = input.period
      ? null
      : (input.previousHeads?.[projectId] ?? null);
    const changes = await projectChangesSince(db, actor, {
      projectId,
      fromSha,
      sinceDate,
      limit: MAX_COMMITS_PER_PROJECT,
    });
    if (input.period)
      changes.commits = changes.commits.filter(
        (commit) => commit.date >= sinceDate && commit.date <= input.now,
      );
    if (changes.headSha) heads[projectId] = changes.headSha;
    if (changes.fallback === "since_date") fallback = "since_date";
    if (changes.truncated) truncated = true;
    commits += changes.commits.length;
    commitsByProject.set(projectId, changes.commits.length);
    const oldest = changes.commits.at(-1)?.date ?? null;
    if (oldest && (!periodFrom || oldest < periodFrom)) periodFrom = oldest;
    const diffs: DigestProject["diffs"] = [];
    const seen = new Set<string>();
    // getDiff resolves a revision only through the document's own --follow log,
    // so both ends must be commits that touched this document.
    const revisions = new Map<
      string,
      { toSha: string; oldestTouching: string }
    >();
    for (const commit of changes.commits) {
      for (const doc of commit.documents) {
        if (!doc.id) continue;
        const known = revisions.get(doc.id);
        if (known) known.oldestTouching = commit.sha;
        else
          revisions.set(doc.id, {
            toSha: commit.sha,
            oldestTouching: commit.sha,
          });
      }
    }
    const repo = revisions.size ? await openProjectRepo(projectId) : null;
    for (const commit of changes.commits) {
      for (const doc of commit.documents) {
        if (
          !doc.id ||
          doc.id === input.excludeDocumentId ||
          seen.has(doc.id) ||
          diffBudget === 0
        )
          continue;
        seen.add(doc.id);
        const revision = revisions.get(doc.id);
        if (!repo || !revision) continue;
        try {
          const history = await repo.logForPath(doc.path, {
            skip: 0,
            limit: 2,
            commitish: revision.oldestTouching,
          });
          const previous = history[1]?.sha;
          // No earlier revision: the document was created inside the window.
          if (!previous) continue;
          const diff = await getDiff(
            db,
            {
              projectId,
              documentId: doc.id,
              fromSha: previous,
              toSha: revision.toSha,
            },
            actor,
          );
          if ("tooLarge" in diff) continue;
          const lines = diff.lines
            .filter((line) => line.type !== "same")
            .map((line) => `${line.type === "add" ? "+" : "-"} ${line.text}`);
          if (lines.length === 0) continue;
          const fullText = lines.join("\n");
          const text = cutToBytes(fullText, MAX_DIFF_CHARS);
          if (text !== fullText) truncated = true;
          diffs.push({ title: doc.title, lines: text.split("\n") });
          diffBudget -= 1;
        } catch {
          // A document that no longer exists at either end has no diff to show.
        }
      }
    }
    digestProjects.push({
      projectName: project?.name ?? projectId,
      commits: changes.commits,
      diffs,
    });
  }

  const fullDigest = renderDigest(digestProjects, {
    excludeDocumentId: input.excludeDocumentId,
  });
  const digestBudget = Math.floor(input.inputBytes * DIGEST_SHARE);
  const digest = cutToBytes(fullDigest, digestBudget);
  if (digest !== fullDigest) truncated = true;
  const contentBudget = input.inputBytes - bytes(digest);

  const blocks: ProjectBlock[] = [];
  const documentBlock = async (
    projectId: string,
    documentId: string,
  ): Promise<ProjectBlock | null> => {
    if (documentId === input.excludeDocumentId) return null;
    const doc = await getDocument(db, { projectId, documentId }, actor);
    const body = documentContentText(doc.content);
    const text = cutToBytes(body, MAX_DOCUMENT_CHARS);
    return {
      projectId,
      kind: "document",
      text: `## Document: ${doc.title}\n${text}`,
      truncated: text !== body,
    };
  };
  const tableBlock = async (
    projectId: string,
    tableId: string,
  ): Promise<ProjectBlock> => {
    const table = await getTable(db, { projectId, tableId }, actor);
    return {
      projectId,
      kind: "table",
      text: renderTableSample(
        {
          title: table.title,
          columns: table.columns,
          rows: flattenTableRows(table.columns, table.rows),
        },
        MAX_TABLE_ROWS,
      ),
      truncated: table.rows.length > MAX_TABLE_ROWS,
    };
  };

  if (
    input.scope.kind === "document" &&
    input.scope.documentId &&
    input.scope.projectIds[0]
  ) {
    const block = await documentBlock(
      input.scope.projectIds[0],
      input.scope.documentId,
    );
    if (block) blocks.push(block);
  } else if (
    input.scope.kind === "table" &&
    input.scope.tableId &&
    input.scope.projectIds[0]
  ) {
    blocks.push(
      await tableBlock(input.scope.projectIds[0], input.scope.tableId),
    );
  } else {
    // Equal shares: filling the budget project by project would leave every
    // project after the first unrepresented in a multi-project scope.
    const projectCount = Math.max(input.scope.projectIds.length, 1);
    const share = Math.floor(
      Math.max(contentBudget - (projectCount - 1) * BLOCK_SEPARATOR_BYTES, 0) /
        projectCount,
    );
    for (const projectId of input.scope.projectIds) {
      const forProject: ProjectBlock[] = [];
      const shareUsed = () =>
        forProject.reduce(
          (total, block) => total + bytes(block.text) + BLOCK_SEPARATOR_BYTES,
          0,
        );
      const docs = await listDocuments(
        db,
        {
          projectId,
          page: 1,
          pageSize: LIST_PAGE,
          sort: "lastEditedAt",
          dir: "desc",
        },
        actor,
      );
      for (const item of docs.items) {
        if (shareUsed() > share) break;
        const block = await documentBlock(projectId, item.id);
        if (block) forProject.push(block);
      }
      const tbls = await listTables(
        db,
        { projectId, page: 1, pageSize: 50, sort: "lastEditedAt", dir: "desc" },
        actor,
      );
      for (const item of tbls.items) {
        if (shareUsed() > share) break;
        forProject.push(await tableBlock(projectId, item.id));
      }
      const withinShare = fitWithinBudget(forProject, share);
      if (withinShare.truncated) truncated = true;
      blocks.push(...withinShare.blocks);
    }
  }
  const kept = selectWithinBudget(blocks, contentBudget);
  if (kept.truncated) truncated = true;
  const included = blocks.slice(0, kept.blocks.length);
  return {
    digest,
    content: kept.blocks.join(BLOCK_SEPARATOR),
    summary: {
      documents: kept.documents,
      tables: kept.tables,
      commits,
      truncated,
      fallback,
      projects: input.scope.projectIds.map((projectId) => ({
        projectId,
        documents: included.filter(
          (block) => block.projectId === projectId && block.kind === "document",
        ).length,
        tables: included.filter(
          (block) => block.projectId === projectId && block.kind === "table",
        ).length,
        commits: commitsByProject.get(projectId) ?? 0,
      })),
    },
    heads,
    period: { from: input.period ? sinceDate : periodFrom, to: input.now },
  };
}
