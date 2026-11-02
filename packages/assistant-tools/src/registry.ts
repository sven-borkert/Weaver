import { EXAM_READ_TOOLS } from "./tools/exams/read";
import { EXAM_PROPOSE_TOOLS } from "./tools/exams/propose";
import { EXAM_WRITE_TOOLS, gradeExamAttemptTool } from "./tools/exams/write";
import { readTextArtifactTool } from "./tools/artifactsText";
import { readCsvArtifactTool } from "./tools/artifactsCsv";
import { inspectStructuredArtifactTool } from "./tools/artifactsStructured";
import { SCHEDULED_TASK_READ_ADMIN_TOOLS } from "./tools/admin/scheduledTaskRead";
import { aggregateTableTool } from "./tools/aggregate";
import { readOneNoteTool } from "./tools/artifactsNotebook";
import {
  getArtifactOverviewTool,
  queryJsonArtifactTool,
  readExcelSheetTool,
  readPdfPagesTool,
  searchArtifactTextTool,
  searchArtifactsTool,
} from "./tools/artifacts";
import {
  findWordTablesTool,
  readWordBlocksTool,
  readWordChapterTool,
  readWordTableTool,
} from "./tools/artifactsWord";
import {
  hasCapability,
  type UserSecurityContext,
} from "@weaver/core/security/context";
import type { AnyToolContract } from "./contract";
import { DIAGNOSTICS_ADMIN_TOOLS } from "./tools/admin/diagnostics";
import { ASSISTANT_READ_ADMIN_TOOLS } from "./tools/admin/assistantRead";
import { LLM_READ_ADMIN_TOOLS } from "./tools/admin/llmRead";
import { LLM_WRITE_ADMIN_TOOLS } from "./tools/admin/llmWrite";
import { CONNECTION_READ_TOOLS } from "./tools/connections/read";
import { CONNECTION_WRITE_TOOLS } from "./tools/connections/write";
import { KNOWLEDGE_READ_ADMIN_TOOLS } from "./tools/admin/knowledgeRead";
import { KNOWLEDGE_WRITE_ADMIN_TOOLS } from "./tools/admin/knowledgeWrite";
import { OPERATIONS_ADMIN_TOOLS } from "./tools/admin/operations";
import { INGESTION_READ_ADMIN_TOOLS } from "./tools/admin/ingestionRead";
import { WIKI_READ_TOOLS } from "./tools/wiki";
import { resolveCitationTool } from "./tools/citations";
import { listDocumentsTool, readDocumentTool } from "./tools/documents";
import { listContentFoldersTool } from "./tools/folders";
import { contentHistoryTool } from "./tools/history";
import { navigateDocumentTool } from "./tools/navigate";
import {
  entityDetailTool,
  entityNeighborhoodTool,
  searchEntitiesTool,
} from "./tools/graph";
import { listProjectsTool } from "./tools/projects";
import {
  proposeContentLifecycleTool,
  proposeContentRestoreTool,
  proposeDocumentCreateTool,
  proposeDocumentEditTool,
  proposeDocumentPatchTool,
  proposeTableChangeTool,
  proposeTableCreateTool,
} from "./tools/proposals";
import { searchKnowledgeTool } from "./tools/search";
import {
  getTableTool,
  listTablesTool,
  queryTableRowsTool,
} from "./tools/tables";
import {
  listTableColumnOptionsTool,
  listTableColumnsTool,
  readTableCellTool,
} from "./tools/tableReads";
import {
  applyContentLifecycleTool,
  changeTableTool,
  createDocumentTool,
  createTableTool,
  patchDocumentTool,
  restoreContentTool,
  updateDocumentTool,
  updateTableRowsTool,
  updateTableSchemaTool,
} from "./tools/writes";

// propose_table_schema_change and propose_table_rows are superseded by
// propose_table_change and were deleted: exposing all three wastes prompt
// budget and lets the model raise two proposals against one base whose
// second conflicts once the first is accepted (concept §2). MCP_TOOLS never
// carried propose-kind tools; their MCP counterparts update_table_schema and
// update_table_rows remain, and the persisted table.schema / table.rows
// operation variants stay parseable so pending proposals are still acceptable.
export const ASSISTANT_TOOLS: readonly AnyToolContract[] = [
  listProjectsTool,
  listDocumentsTool,
  readDocumentTool,
  navigateDocumentTool,
  contentHistoryTool,
  listContentFoldersTool,
  listTablesTool,
  getTableTool,
  queryTableRowsTool,
  listTableColumnsTool,
  listTableColumnOptionsTool,
  readTableCellTool,
  aggregateTableTool,
  searchArtifactsTool,
  getArtifactOverviewTool,
  searchArtifactTextTool,
  queryJsonArtifactTool,
  readTextArtifactTool,
  readCsvArtifactTool,
  inspectStructuredArtifactTool,
  readPdfPagesTool,
  readWordChapterTool,
  readWordBlocksTool,
  findWordTablesTool,
  readWordTableTool,
  readExcelSheetTool,
  readOneNoteTool,
  searchKnowledgeTool,
  searchEntitiesTool,
  entityNeighborhoodTool,
  entityDetailTool,
  resolveCitationTool,
  proposeDocumentCreateTool,
  proposeDocumentEditTool,
  proposeTableCreateTool,
  proposeDocumentPatchTool,
  proposeTableChangeTool,
  proposeContentRestoreTool,
  proposeContentLifecycleTool,
];

export function toolsForActor(actor: UserSecurityContext): AnyToolContract[] {
  return ASSISTANT_TOOLS.filter((tool) =>
    hasCapability(actor, tool.capability),
  );
}

export function toolByName(name: string): AnyToolContract | undefined {
  return ASSISTANT_TOOLS.find((tool) => tool.name === name);
}

export const WRITE_TOOLS: readonly AnyToolContract[] = [
  createDocumentTool,
  updateDocumentTool,
  patchDocumentTool,
  createTableTool,
  updateTableSchemaTool,
  updateTableRowsTool,
  changeTableTool,
  restoreContentTool,
  applyContentLifecycleTool,
];

/** Admin tools are MCP-only (diagnostics design §3.2, §10.1); the assistant registry never sees them. */
export const ADMIN_TOOLS: readonly AnyToolContract[] = [
  ...OPERATIONS_ADMIN_TOOLS,
  ...ASSISTANT_READ_ADMIN_TOOLS,
  ...DIAGNOSTICS_ADMIN_TOOLS,
  ...LLM_READ_ADMIN_TOOLS,
  ...LLM_WRITE_ADMIN_TOOLS,
  ...KNOWLEDGE_READ_ADMIN_TOOLS,
  ...KNOWLEDGE_WRITE_ADMIN_TOOLS,
  ...INGESTION_READ_ADMIN_TOOLS,
  ...SCHEDULED_TASK_READ_ADMIN_TOOLS,
];

/** A user's own MCP connections (personal connections design §8); never in the assistant registry. */
export const CONNECTION_TOOLS: readonly AnyToolContract[] = [
  ...CONNECTION_READ_TOOLS,
  ...CONNECTION_WRITE_TOOLS,
];

/** Spec §26.2 item 1: MCP exposes read + direct write; proposals need a run and stay assistant-only. */
export const EXAM_TOOLS: readonly AnyToolContract[] = [
  ...EXAM_READ_TOOLS,
  ...EXAM_WRITE_TOOLS,
];
/** Assistant runs propose exam definitions for review; grades already wait for release in the browser. */
export const ASSISTANT_EXAM_TOOLS: readonly AnyToolContract[] = [
  ...EXAM_READ_TOOLS,
  ...EXAM_PROPOSE_TOOLS,
  gradeExamAttemptTool,
];
export function examToolsForActor(
  actor: UserSecurityContext,
): AnyToolContract[] {
  return ASSISTANT_EXAM_TOOLS.filter((tool) =>
    hasCapability(actor, tool.capability),
  );
}

/** Wiki reads are MCP-only until the assistant gets them with the wiki settings. */
export const WIKI_TOOLS: readonly AnyToolContract[] = WIKI_READ_TOOLS;

export const MCP_TOOLS: readonly AnyToolContract[] = [
  ...ASSISTANT_TOOLS.filter((tool) => tool.kind === "read"),
  ...WIKI_TOOLS,
  ...WRITE_TOOLS,
  ...ADMIN_TOOLS,
  ...CONNECTION_TOOLS,
  ...EXAM_TOOLS,
];

export function mcpToolsForActor(
  actor: UserSecurityContext,
): AnyToolContract[] {
  return MCP_TOOLS.filter((tool) => hasCapability(actor, tool.capability));
}

export function mcpToolByName(name: string): AnyToolContract | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
