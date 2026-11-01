import { z } from "zod";
import type {
  BackgroundWorkKind,
  BackgroundWorkState,
  WorkAudience,
  WorkDestination,
} from "../jobs/backgroundWorkSchema";
import type { DocumentKind } from "../documents/kinds";
import type { ProjectRoleName } from "../roles";

export const DASHBOARD_LIMITS = {
  contentActivityDays: 30,
  workResultDays: 7,
  activityDefault: 20,
  activityMax: 50,
  activityCursorLength: 2000,
  recentContentDefault: 8,
  recentContentMax: 20,
  reportShortcuts: 5,
  homeProjectPreview: 6,
  projectPins: 12,
  pinCandidates: 20,
  pinSearchLength: 200,
  pinSearchDebounceMs: 200,
  projectCountCap: 10_000,
  refreshMs: 30_000,
  projectActiveWorkPreview: 3,
} as const;

export const ACTIVITY_SOURCES = [
  "document",
  "table",
  "task",
  "import",
  "assistant",
  "knowledge",
] as const;

const contentKind = z.enum(["document", "table"]);

export const activityInput = z
  .object({
    audience: z.enum(["mine", "projects"]).default("mine"),
    projectId: z.uuid().optional(),
    view: z.enum(["all", "others", "results"]).default("all"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (input) => input.audience !== "projects" || input.projectId !== undefined,
    { message: "Project work requires a project", path: ["projectId"] },
  );

export const recentContentInput = z
  .object({
    projectId: z.uuid().optional(),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();

export const projectOverviewInput = z.object({ projectId: z.uuid() }).strict();

export const reportsInput = z
  .object({ projectId: z.uuid().optional() })
  .strict()
  .optional();

export const pinCandidatesInput = z
  .object({
    projectId: z.uuid(),
    kind: contentKind.optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

export const pinContentInput = z
  .object({
    projectId: z.uuid(),
    kind: contentKind,
    resourceId: z.uuid(),
  })
  .strict();

export const unpinContentInput = z
  .object({ projectId: z.uuid(), pinId: z.uuid() })
  .strict();

export type ContentKind = "document" | "table";
export type ContentDestination =
  | { kind: "document"; projectId: string; documentId: string }
  | { kind: "table"; projectId: string; tableId: string };
export type DashboardDestination = ContentDestination | WorkDestination;
export type ActivityView = "all" | "others" | "results";
export type ActivitySource = ContentKind | BackgroundWorkKind;
export type BoundedCount = { value: number; capped: boolean };
export type ContentCard = {
  id: string;
  kind: ContentKind;
  title: string;
  projectId: string;
  projectName: string;
  lastEditedAt: string;
  editorName: string | null;
  isOwnChange: boolean;
  documentKind: DocumentKind | null;
  destination: ContentDestination;
};
export type ActivityEntry = {
  id: string;
  source: ActivitySource;
  category: "content_update" | "work_result";
  title: string;
  projectId: string | null;
  projectName: string | null;
  sortAt: string;
  occurredAt: string | null;
  editorName: string | null;
  isOwnChange: boolean | null;
  state: BackgroundWorkState | null;
  sourceStatus: string | null;
  destination: DashboardDestination;
  currentReport: Extract<ContentDestination, { kind: "document" }> | null;
};
export type ActivityInput = {
  audience?: WorkAudience;
  projectId?: string;
  view?: ActivityView;
  limit?: number;
  cursor?: string;
};
export type ActivityPage = {
  items: ActivityEntry[];
  nextCursor: string | null;
  observedAt: string;
};
export type RecentContentInput = { projectId?: string; limit?: number };
export type RecentContentPage = { items: ContentCard[]; observedAt: string };
export type ReportShortcut = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  status: "active" | "paused";
  lastRunStatus:
    "queued" | "running" | "succeeded" | "failed" | "skipped" | null;
  nextRunAt: string | null;
  destination: Extract<WorkDestination, { kind: "task" }>;
  currentReport: Extract<ContentDestination, { kind: "document" }> | null;
};
export type ReportShortcuts = { items: ReportShortcut[]; observedAt: string };
export type ProjectPinView =
  | { pinId: string; kind: ContentKind; available: true; content: ContentCard }
  | { pinId: string; kind: ContentKind; available: false };
export type ProjectOverview = {
  project: {
    id: string;
    name: string;
    description: string | null;
    myRole: ProjectRoleName;
  };
  counts: { documents: BoundedCount; tables: BoundedCount };
  pins: ProjectPinView[];
  pinCapacity: { used: number; limit: 12 } | null;
  canManagePins: boolean;
  workAudience: WorkAudience;
  observedAt: string;
};
export type PinCandidatesInput = {
  projectId: string;
  kind?: ContentKind;
  search?: string;
};
export type PinContentInput = {
  projectId: string;
  kind: ContentKind;
  resourceId: string;
};
export type UnpinContentInput = { projectId: string; pinId: string };
