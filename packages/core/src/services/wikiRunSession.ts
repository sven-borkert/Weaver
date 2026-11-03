import type { PrismaClient } from "@weaver/db/client";
import { emitDiagnostic } from "../diagnostics/writer";
import { CoreError } from "../errors";
import { normalizeKnowledgeName } from "../knowledge/extraction";
import { redactSecrets } from "../security/redactSecrets";
import {
  createWikiAgentSecurityContext,
  type WikiAgentSecurityContext,
} from "../security/context";
import {
  preprocessAgentMarkdown,
  type AgentLinkResolver,
  type InvalidLink,
  type UnresolvedLink,
} from "../wiki/agentMarkdown";
import {
  formatWikiOperationId,
  WIKI_BUDGET_REFUSALS_STOP_RUN,
  type BudgetDelta,
} from "../wiki/budget";
import { WIKI_RUN_CAPS } from "../wiki/caps";
import { normalizeGuideText, stripIgnorable } from "../wiki/guideText";
import { trackedLink } from "../wiki/links";
import { hashNormalizedTitle } from "./searchLexical";
import {
  applyWikiOperation,
  wikiRequestHash,
  type WikiOperation,
  type WikiWriteLedger,
  type WikiWriteMeasure,
} from "./wikiOperations";
import {
  assertLiveWikiRun,
  type LeasedWikiRun,
  wikiRunFence,
} from "./wikiRuns";
import { wikiWriteGuardsFor } from "./wikiSettings";

export const WIKI_NOTE_BLOCK_MAX_CHARS = 8_000;
export const WIKI_SUMMARY_MAX_CHARS = 4_000;
export const WIKI_SUGGESTION_MAX_CHARS = 1_000;
export const WIKI_SUGGESTIONS_PER_RUN = 5;
const OUTCOME_NOTE_MAX_CHARS = 1_000;
const UNWANTED_CHARS = /[\x00-\x08\x0b-\x1f\x7f\p{Zl}\p{Zp}\p{Cf}]/gu;
const UNVERIFIED_PATH_MAX = 1_024;

export type WikiWriteOutcome = {
  documentId: string | null;
  path: string;
  commitSha: string;
  baseCommitSha: string;
  link: string | null;
  existing: boolean;
  unresolvedLinks: UnresolvedLink[];
  invalidLinks: InvalidLink[];
};

export type WikiPageProps = {
  type?: string | null;
  summary?: string | null;
  tags?: string[] | null;
};

type PatchActions = Extract<
  WikiOperation,
  { kind: "document.patch" }
>["actions"];

/** Control, bidi and format characters are dropped, not refused. */
function stripUnwanted(raw: string): string {
  return stripIgnorable(raw.replace(UNWANTED_CHARS, ""));
}

function plainText(
  raw: string,
  max: number,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const text = stripUnwanted(raw).trim();
  if ((!options.allowEmpty && text.length === 0) || text.length > max)
    throw new CoreError(
      "BAD_REQUEST",
      `${field} must be plain text of at most ${max} characters`,
    );
  return text;
}

async function resolver(
  db: PrismaClient,
  projectId: string,
): Promise<AgentLinkResolver> {
  return {
    async byTitle(title) {
      const normalized = normalizeKnowledgeName(title);
      const rows = await db.document.findMany({
        where: {
          projectId,
          wikiSourceItemId: null,
          normalizedTitleHash: new Uint8Array(hashNormalizedTitle(normalized)),
        },
        select: { id: true, title: true, normalizedTitle: true },
        take: 5,
      });
      return rows.filter((row) => row.normalizedTitle === normalized);
    },
    async byPath(path) {
      return db.document.findFirst({
        where: { projectId, path, wikiSourceItemId: null },
        select: { id: true, title: true },
      });
    },
    async exists(kind, id) {
      return kind === "document"
        ? db.document.findFirst({
            where: { id, projectId },
            select: { title: true },
          })
        : db.dataTable.findFirst({
            where: { id, projectId },
            select: { title: true },
          });
    },
  };
}

/** One run attempt's state; the tools reach the database only through this. */
export class WikiRunSession {
  readonly actor: WikiAgentSecurityContext;
  currentItemId: string | null = null;
  finished: { summary: string } | null = null;
  stopRequested: string | null = null;
  readonly loadedTools = new Set<string>();

  constructor(
    readonly db: PrismaClient,
    readonly lease: LeasedWikiRun,
    /** Bytes of tool schema this attempt may still load. */
    readonly schemaReserveBytes = 0,
  ) {
    this.actor = createWikiAgentSecurityContext({
      agentId: lease.agentId,
      projectId: lease.projectId,
    });
  }

  get projectId(): string {
    return this.lease.projectId;
  }

  assertLive(): Promise<void> {
    return assertLiveWikiRun(this.db, this.lease);
  }

  private requireIngest(what: string): void {
    if (this.lease.kind !== "ingest")
      throw new CoreError(
        "BAD_REQUEST",
        `${what} applies to ingest runs only; this run has no inputs`,
      );
  }

  private async requireRunItem(id: string) {
    const item = await this.db.wikiInputItem.findFirst({
      where: { id, projectId: this.projectId, runId: this.lease.id },
    });
    if (!item) throw new CoreError("NOT_FOUND", "Input not found in this run");
    return item;
  }

  async listInputs() {
    const items = await this.db.wikiInputItem.findMany({
      where: { projectId: this.projectId, runId: this.lease.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        title: true,
        byteSize: true,
        status: true,
      },
    });
    return items.map((item) => ({
      ...item,
      current: item.id === this.currentItemId,
    }));
  }

  /** Metadata only: the text is read through the ordinary reads, window by window. */
  async readInput(id: string) {
    this.requireIngest("read_input");
    const item = await this.requireRunItem(id);
    if (item.status !== "ready" && item.status !== "processing")
      throw new CoreError(
        "CONFLICT",
        `This input is ${item.status}, not available to read`,
      );
    if (item.status === "ready") {
      const { count } = await this.db.wikiInputItem.updateMany({
        where: { id, runId: this.lease.id, status: "ready" },
        data: { status: "processing", revision: { increment: 1 } },
      });
      if (count === 0)
        throw new CoreError(
          "CONFLICT",
          "This input changed; list inputs again",
        );
    }
    this.currentItemId = id;
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      size: item.byteSize,
      sourceDocumentId: item.sourceDocumentId,
      sourceTableId: item.sourceTableId,
      warnings: item.outcomeNote ? [item.outcomeNote] : [],
      notes: item.agentNote,
    };
  }

  async writeNote(text: string): Promise<{ chars: number }> {
    this.requireIngest("wiki_note");
    if (!this.currentItemId)
      throw new CoreError("BAD_REQUEST", "Call read_input first");
    const clean = stripUnwanted(text);
    if (clean.length > WIKI_NOTE_BLOCK_MAX_CHARS)
      throw new CoreError(
        "BAD_REQUEST",
        `Notes are limited to ${WIKI_NOTE_BLOCK_MAX_CHARS} characters`,
      );
    await this.db.wikiInputItem.updateMany({
      where: { id: this.currentItemId, runId: this.lease.id },
      data: { agentNote: clean },
    });
    return { chars: clean.length };
  }

  async currentNote(): Promise<string | null> {
    if (!this.currentItemId) return null;
    const item = await this.db.wikiInputItem.findUnique({
      where: { id: this.currentItemId },
      select: { agentNote: true },
    });
    return item?.agentNote ?? null;
  }

  async completeInput(
    id: string,
    outcome: "integrated" | "skipped",
    note: string,
  ): Promise<{ id: string; status: string }> {
    this.requireIngest("complete_input");
    const item = await this.requireRunItem(id);
    const outcomeNote = redactSecrets(
      plainText(note, OUTCOME_NOTE_MAX_CHARS, "note"),
    );
    if (item.status !== "processing")
      throw new CoreError(
        "CONFLICT",
        "Call read_input for this input before completing it",
      );
    if (outcome === "integrated") {
      const referenced = await this.db.wikiRunOperation.count({
        where: {
          runId: this.lease.id,
          inputItemId: id,
          status: "committed",
          sourceReferenced: true,
        },
      });
      if (referenced === 0)
        throw new CoreError(
          "CONFLICT",
          "No committed write in this run references this input; create or patch a page first, or complete it as skipped",
          { reason: "NOT_INTEGRATED" },
        );
    }
    const status = outcome === "integrated" ? "processed" : "skipped";
    const { count } = await this.db.wikiInputItem.updateMany({
      where: { id, runId: this.lease.id, status: "processing" },
      data: {
        status,
        outcomeNote,
        agentNote: null,
        revision: { increment: 1 },
        ...(outcome === "integrated"
          ? { processedAt: new Date(), text: null }
          : {}),
      },
    });
    if (count === 0)
      throw new CoreError("CONFLICT", "This input changed; list inputs again");
    if (this.currentItemId === id) this.currentItemId = null;
    emitDiagnostic({
      event:
        outcome === "integrated"
          ? "wiki.input.processed"
          : "wiki.input.skipped",
      message: `wiki input ${status}`,
      outcome: "ok",
      projectId: this.projectId,
      details: { itemId: id, runId: this.lease.id },
    });
    return { id, status };
  }

  async suggestGuideChange(raw: string): Promise<{ id: string }> {
    const text = normalizeGuideText(
      plainText(raw, WIKI_SUGGESTION_MAX_CHARS, "text"),
    ).text;
    if (text.trim().length === 0)
      throw new CoreError("BAD_REQUEST", "text is empty");
    return this.db.$transaction(async (tx) => {
      const count = await tx.wikiGuideSuggestion.count({
        where: { runId: this.lease.id },
      });
      if (count >= WIKI_SUGGESTIONS_PER_RUN)
        throw new CoreError(
          "CONFLICT",
          `At most ${WIKI_SUGGESTIONS_PER_RUN} suggestions per run`,
        );
      const row = await tx.wikiGuideSuggestion.create({
        data: { projectId: this.projectId, runId: this.lease.id, text },
        select: { id: true },
      });
      return row;
    });
  }

  finishRun(raw: string): { finished: true } {
    this.finished = {
      summary: redactSecrets(plainText(raw, WIKI_SUMMARY_MAX_CHARS, "summary")),
    };
    return { finished: true };
  }

  private requireWritableContext(): string | null {
    // A lint run has no inputs, so it writes without a current item.
    if (this.lease.kind === "lint") return null;
    if (!this.currentItemId)
      throw new CoreError(
        "BAD_REQUEST",
        "Call read_input for the input you are integrating before writing",
      );
    return this.currentItemId;
  }

  private async sourceRef(
    itemId: string | null,
  ): Promise<{ kind: "document" | "table"; id: string } | undefined> {
    if (!itemId) return undefined;
    const item = await this.requireRunItem(itemId);
    if (item.sourceDocumentId)
      return { kind: "document", id: item.sourceDocumentId };
    if (item.sourceTableId) return { kind: "table", id: item.sourceTableId };
    return undefined;
  }

  /** Atomic and fenced: a closed lease allocates nothing; a restart resumes above the stored counter. */
  private async reserve(input: {
    operation: WikiOperation;
    toolName: string;
    inputItemId: string | null;
    documentId?: string;
    baseCommitSha?: string;
    sourceReferenced: boolean;
  }): Promise<{ n: number; operationId: string }> {
    const requestHash = wikiRequestHash(input.operation);
    const cap = WIKI_RUN_CAPS[this.lease.kind].writes;
    const reserved = await this.db.$transaction(async (tx) => {
      const [run] = await tx.wikiRun.updateManyAndReturn({
        where: {
          id: this.lease.id,
          status: "running",
          leaseToken: this.lease.leaseToken,
        },
        data: { operationCounter: { increment: 1 } },
        select: { operationCounter: true, writes: true },
      });
      if (!run)
        throw new CoreError("CONFLICT", "The run's lease is gone", {
          reason: "WIKI_FENCE_CLOSED",
        });
      // The run row is locked by the update above, so parallel reserves count one at a time.
      const used = await tx.wikiRunOperation.count({
        where: {
          runId: this.lease.id,
          status: { in: ["reserved", "committed"] },
        },
      });
      // Classify caps pages, not property writes; a page with a type and a summary counts two writes.
      const capped =
        this.lease.kind === "classify"
          ? used >= cap
          : run.writes >= cap || used >= cap;
      if (capped) return { capped: true as const };
      const n = run.operationCounter;
      const operationId = formatWikiOperationId("wiki-run", this.lease.id, n);
      await tx.wikiRunOperation.create({
        data: {
          runId: this.lease.id,
          n,
          inputItemId: input.inputItemId,
          toolName: input.toolName,
          requestHash,
          operationId,
          documentId: input.documentId ?? null,
          baseCommitSha: input.baseCommitSha ?? null,
          sourceReferenced: input.sourceReferenced,
        },
      });
      return { capped: false as const, n, operationId };
    });
    if (reserved.capped) {
      this.stopRequested = "write_cap";
      throw new CoreError("CONFLICT", "This run reached its write limit", {
        reason: "RUN_CAP",
      });
    }
    return { n: reserved.n, operationId: reserved.operationId };
  }

  private ledgerFor(n: number): WikiWriteLedger {
    const { db, lease } = this;
    return {
      counters: async (documentId) => {
        const [page, run] = await Promise.all([
          db.wikiPageBudget.findUnique({
            where: { runId_documentId: { runId: lease.id, documentId } },
            select: { grossCharsChanged: true, charsAdded: true },
          }),
          db.wikiPageBudget.aggregate({
            where: { runId: lease.id },
            _sum: { grossCharsChanged: true, charsAdded: true },
          }),
        ]);
        const zero: BudgetDelta = { grossCharsChanged: 0, charsAdded: 0 };
        return {
          page: page ?? zero,
          run: {
            grossCharsChanged: run._sum.grossCharsChanged ?? 0,
            charsAdded: run._sum.charsAdded ?? 0,
          },
        };
      },
      record: (measure: WikiWriteMeasure) =>
        db.$transaction(async (tx) => {
          await tx.wikiRunOperation.update({
            where: { runId_n: { runId: lease.id, n } },
            data: {
              grossCharsChanged: measure.grossCharsChanged,
              charsAdded: measure.charsAdded,
              ...(measure.path
                ? { path: measure.path.slice(0, UNVERIFIED_PATH_MAX) }
                : {}),
            },
          });
          await tx.wikiRun.update({
            where: { id: lease.id },
            data: {
              writes: { increment: measure.writes },
              grossCharsChanged: { increment: measure.grossCharsChanged },
            },
          });
          if (measure.owned || !measure.documentId) return;
          await tx.wikiPageBudget.upsert({
            where: {
              runId_documentId: {
                runId: lease.id,
                documentId: measure.documentId,
              },
            },
            create: {
              runId: lease.id,
              documentId: measure.documentId,
              baselineCommitSha: measure.baseCommitSha ?? "",
              grossCharsChanged: measure.grossCharsChanged,
              charsAdded: measure.charsAdded,
            },
            update: {
              grossCharsChanged: { increment: measure.grossCharsChanged },
              charsAdded: { increment: measure.charsAdded },
            },
          });
        }),
      refused: async () => {
        const run = await db.wikiRun.update({
          where: { id: lease.id },
          data: { budgetRefusals: { increment: 1 } },
          select: { budgetRefusals: true },
        });
        if (run.budgetRefusals >= WIKI_BUDGET_REFUSALS_STOP_RUN)
          this.stopRequested = "destructive_budget";
      },
    };
  }

  private async write(input: {
    operation: WikiOperation;
    toolName: string;
    inputItemId: string | null;
    documentId?: string;
    baseCommitSha?: string;
  }): Promise<{ resourceId: string | null; path: string; commitSha: string }> {
    const sourceReferenced =
      input.operation.kind !== "content.lifecycle" &&
      input.operation.source !== undefined;
    const { n, operationId } = await this.reserve({
      ...input,
      sourceReferenced,
    });
    let result: Awaited<ReturnType<typeof applyWikiOperation>>;
    try {
      result = await applyWikiOperation(this.db, {
        run: wikiRunFence(this.db, this.lease),
        guards: () => wikiWriteGuardsFor(this.db, this.projectId),
        operation: input.operation,
        operationId,
        ledger: this.ledgerFor(n),
      });
    } catch (error) {
      // A reserved row after a crash is reconciled; a thrown write simply did not happen.
      await this.db.wikiRunOperation
        .update({
          where: { runId_n: { runId: this.lease.id, n } },
          data: { status: "failed" },
        })
        .catch(() => undefined);
      throw error;
    }
    // Committed in Git: from here the op is never failed; a lost update stays reserved for reconciliation.
    await this.db.wikiRunOperation.update({
      where: { runId_n: { runId: this.lease.id, n } },
      data: {
        status: "committed",
        commitSha: result.commitSha,
        committedAt: new Date(),
        documentId: result.resourceId,
        path: result.path.slice(0, UNVERIFIED_PATH_MAX),
      },
    });
    await checkDestructivePause(this.db, this.projectId);
    const run = await this.db.wikiRun.findUniqueOrThrow({
      where: { id: this.lease.id },
      select: { writes: true },
    });
    if (
      this.lease.kind !== "classify" &&
      run.writes >= WIKI_RUN_CAPS[this.lease.kind].writes
    )
      this.stopRequested = "write_cap";
    return result;
  }

  async createPage(input: {
    folderPath: string[];
    title: string;
    markdown: string;
    properties: WikiPageProps;
  }): Promise<WikiWriteOutcome> {
    const itemId = this.requireWritableContext();
    if (this.lease.kind === "lint") await this.assertLintMayCreate(input);
    const existing = await this.existingPageForItem(itemId, input);
    if (existing) return existing;
    const processed = await preprocessAgentMarkdown(
      input.markdown,
      await resolver(this.db, this.projectId),
      { folderPath: input.folderPath },
    );
    const source = await this.sourceRef(itemId);
    const result = await this.write({
      toolName: "wiki_create_page",
      inputItemId: itemId,
      operation: {
        kind: "document.create",
        projectId: this.projectId,
        folderPath: input.folderPath,
        title: input.title,
        markdown: processed.markdown,
        properties: input.properties,
        ...(source ? { source } : {}),
      },
    });
    if (this.lease.kind === "lint" && result.resourceId)
      await this.db.projectWikiSettings.updateMany({
        where: {
          projectId: this.projectId,
          agentId: this.lease.agentId,
          reportDocumentId: null,
        },
        data: { reportDocumentId: result.resourceId },
      });
    return {
      documentId: result.resourceId,
      path: result.path,
      commitSha: result.commitSha,
      baseCommitSha: result.commitSha,
      link: trackedLink("document", result.resourceId!, input.title),
      existing: false,
      unresolvedLinks: processed.unresolvedLinks,
      invalidLinks: processed.invalidLinks,
    };
  }

  /** A lint run's only page create is the report, and only while none is recorded. */
  private async assertLintMayCreate(input: {
    properties: WikiPageProps;
  }): Promise<void> {
    const settings = await this.db.projectWikiSettings.findUnique({
      where: { projectId: this.projectId },
      select: { reportDocumentId: true },
    });
    const recorded = settings?.reportDocumentId
      ? await this.db.document.findFirst({
          where: { id: settings.reportDocumentId, projectId: this.projectId },
          select: { id: true },
        })
      : null;
    if (recorded)
      throw new CoreError(
        "CONFLICT",
        "The report page already exists; patch it instead of creating another page",
        { reason: "REPORT_EXISTS" },
      );
    if (input.properties.type !== "report")
      throw new CoreError(
        "BAD_REQUEST",
        "A lint run may create only the report page, with type report",
      );
  }

  /** The current input already made this page: a retried create returns it instead of a -2 twin. */
  private async existingPageForItem(
    itemId: string | null,
    input: { folderPath: string[]; title: string },
  ): Promise<WikiWriteOutcome | null> {
    if (!itemId) return null;
    const ops = await this.db.wikiRunOperation.findMany({
      where: {
        runId: this.lease.id,
        inputItemId: itemId,
        toolName: "wiki_create_page",
        status: "committed",
      },
      select: { documentId: true },
    });
    const ids = ops.flatMap((op) => (op.documentId ? [op.documentId] : []));
    if (ids.length === 0) return null;
    const normalized = normalizeKnowledgeName(input.title);
    const rows = await this.db.document.findMany({
      where: { id: { in: ids }, projectId: this.projectId },
      select: {
        id: true,
        path: true,
        title: true,
        normalizedTitle: true,
        headCommitSha: true,
      },
    });
    const folder = input.folderPath.join("/");
    const match = rows.find(
      (row) =>
        row.normalizedTitle === normalized &&
        row.path.split("/").slice(0, -1).join("/") === folder,
    );
    if (!match) return null;
    return {
      documentId: match.id,
      path: match.path,
      commitSha: match.headCommitSha,
      baseCommitSha: match.headCommitSha,
      link: trackedLink("document", match.id, match.title),
      existing: true,
      unresolvedLinks: [],
      invalidLinks: [],
    };
  }

  async patchPage(input: {
    documentId: string;
    baseCommitSha: string;
    actions: PatchActions;
    properties?: WikiPageProps;
  }): Promise<WikiWriteOutcome> {
    const itemId = this.requireWritableContext();
    const page = await this.db.document.findFirst({
      where: { id: input.documentId, projectId: this.projectId },
      select: { path: true },
    });
    if (!page) throw new CoreError("NOT_FOUND", "target no longer exists");
    const folderPath = page.path.split("/").slice(0, -1);
    const links = await resolver(this.db, this.projectId);
    const unresolvedLinks: UnresolvedLink[] = [];
    const invalidLinks: InvalidLink[] = [];
    const prepare = async (text: string): Promise<string> => {
      const processed = await preprocessAgentMarkdown(text, links, {
        folderPath,
      });
      unresolvedLinks.push(...processed.unresolvedLinks);
      invalidLinks.push(...processed.invalidLinks);
      return processed.markdown;
    };
    const actions: PatchActions = [];
    for (const action of input.actions) {
      if ("text" in action)
        actions.push({ ...action, text: await prepare(action.text) });
      else if ("replace" in action)
        actions.push({ ...action, replace: await prepare(action.replace) });
      else actions.push(action);
    }
    const source = await this.sourceRef(itemId);
    const result = await this.write({
      toolName: "wiki_patch_page",
      inputItemId: itemId,
      documentId: input.documentId,
      baseCommitSha: input.baseCommitSha,
      operation: {
        kind: "document.patch",
        projectId: this.projectId,
        documentId: input.documentId,
        baseCommitSha: input.baseCommitSha,
        actions,
        ...(input.properties ? { properties: input.properties } : {}),
        ...(source ? { source } : {}),
      },
    });
    return {
      documentId: input.documentId,
      path: result.path,
      commitSha: result.commitSha,
      baseCommitSha: result.commitSha,
      link: null,
      existing: false,
      unresolvedLinks,
      invalidLinks,
    };
  }

  /** Classify's only write: a property-only patch from the stored plan, no body actions. */
  async classifyPage(input: {
    documentId: string;
    baseCommitSha: string;
    properties: WikiPageProps;
  }): Promise<{ commitSha: string }> {
    if (this.lease.kind !== "classify")
      throw new CoreError("FORBIDDEN", "Only a classify run applies a plan");
    const result = await this.write({
      toolName: "wiki_patch_page",
      inputItemId: null,
      documentId: input.documentId,
      baseCommitSha: input.baseCommitSha,
      operation: {
        kind: "document.patch",
        projectId: this.projectId,
        documentId: input.documentId,
        baseCommitSha: input.baseCommitSha,
        actions: [],
        properties: input.properties,
      },
    });
    return { commitSha: result.commitSha };
  }

  async createFolder(input: {
    parentPath: string[];
    name: string;
  }): Promise<{ path: string; commitSha: string }> {
    const itemId = this.requireWritableContext();
    if (this.lease.kind === "lint")
      throw new CoreError("BAD_REQUEST", "A lint run does not create folders");
    const result = await this.write({
      toolName: "wiki_create_folder",
      inputItemId: itemId,
      operation: {
        kind: "content.lifecycle",
        action: "folder_create",
        projectId: this.projectId,
        parentPath: input.parentPath,
        name: input.name,
      },
    });
    return { path: result.path, commitSha: result.commitSha };
  }
}

/** Sum of everything run writes changed in the last 24 hours; Revert does not count. */
export async function rollingDestructiveChars(
  db: PrismaClient,
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const { _sum: sum } = await db.wikiRunOperation.aggregate({
    where: {
      status: "committed",
      committedAt: { gte: since, lte: now },
      run: { projectId, kind: { not: "revert" } },
    },
    _sum: { grossCharsChanged: true, charsAdded: true },
  });
  return (sum.grossCharsChanged ?? 0) + (sum.charsAdded ?? 0);
}

/** Pauses new runs when the rolling budget is exceeded; the running one finishes under its own limits. */
export async function checkDestructivePause(
  db: PrismaClient,
  projectId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const settings = await db.projectWikiSettings.findUnique({
    where: { projectId },
    select: { destructiveBudget24h: true, destructivePausedAt: true },
  });
  if (!settings || settings.destructivePausedAt) return false;
  const total = await rollingDestructiveChars(db, projectId, now);
  if (total <= settings.destructiveBudget24h) return false;
  const { count } = await db.projectWikiSettings.updateMany({
    where: { projectId, destructivePausedAt: null },
    data: { destructivePausedAt: now },
  });
  if (count === 1)
    emitDiagnostic({
      event: "wiki.settings.changed",
      severity: "warn",
      message: "wiki destructive budget exceeded; new runs are paused",
      outcome: "blocked",
      projectId,
      details: { change: "destructive_paused" },
    });
  return count === 1;
}
