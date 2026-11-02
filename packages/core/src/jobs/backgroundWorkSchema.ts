import { z } from "zod";

export const BACKGROUND_WORK_KINDS = [
  "task",
  "import",
  "assistant",
  "knowledge",
  "notebook",
  "git_sync",
  "exam",
  "wiki",
] as const;
export const BACKGROUND_WORK_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "skipped",
] as const;
export const PERSONAL_WORK_KINDS = [
  "task",
  "import",
  "assistant",
  "knowledge",
  "notebook",
  "git_sync",
  "exam",
  "wiki",
] as const;
export const BACKGROUND_WORK_LIMITS = {
  recentDays: 7,
  receiptRetentionDays: 14,
  pruneBatch: 5000,
  defaultLimit: 20,
  maxLimit: 50,
  trayLimit: 10,
  maxAcknowledgements: 50,
  summaryCap: 100,
  idlePollMs: 15000,
  activePollMs: 5000,
  titleLength: 200,
} as const;
export type BackgroundWorkKind = (typeof BACKGROUND_WORK_KINDS)[number];
export type PersonalWorkKind = (typeof PERSONAL_WORK_KINDS)[number];
export type BackgroundWorkState = (typeof BACKGROUND_WORK_STATES)[number];
export type WorkAudience = "mine" | "projects";
export type WorkView = "active" | "recent" | "all";
export type WorkDestination =
  | { kind: "task"; projectId: string; taskId: string }
  | { kind: "import"; projectId: string; fileId: string }
  | { kind: "assistant"; conversationId: string }
  | { kind: "knowledge"; projectId: string }
  | { kind: "notebook"; projectId: string; filename: string }
  | { kind: "git_sync"; projectId: string }
  | { kind: "exam"; projectId: string; attemptId: string }
  | { kind: "wiki"; projectId: string };
export const workReferenceSchema = z
  .object({
    kind: z.enum(PERSONAL_WORK_KINDS),
    id: z.uuid(),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type WorkReference = z.infer<typeof workReferenceSchema>;
export const backgroundWorkListInput = z
  .object({
    audience: z.enum(["mine", "projects"]).default("mine"),
    projectId: z.uuid().optional(),
    kind: z.enum(BACKGROUND_WORK_KINDS).optional(),
    view: z.enum(["active", "recent", "all"]).default("all"),
    state: z.enum(BACKGROUND_WORK_STATES).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BACKGROUND_WORK_LIMITS.maxLimit)
      .default(BACKGROUND_WORK_LIMITS.defaultLimit),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type BackgroundWorkListInput = z.input<typeof backgroundWorkListInput>;
export const backgroundWorkMarkSeenInput = z
  .object({
    items: z
      .array(workReferenceSchema)
      .min(1)
      .max(BACKGROUND_WORK_LIMITS.maxAcknowledgements),
  })
  .strict();
export type BackgroundWorkItem = {
  id: string;
  kind: BackgroundWorkKind;
  title: string;
  projectId: string | null;
  projectName: string | null;
  state: BackgroundWorkState;
  sourceStatus: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sortAt: string;
  progress: { ready: number; total: number; failed: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  destination: WorkDestination;
  acknowledgement: WorkReference | null;
  unseen: boolean;
};
export type BackgroundWorkPage = {
  items: BackgroundWorkItem[];
  nextCursor: string | null;
  observedAt: string;
};
export type BackgroundWorkSummary = {
  active: { value: number; capped: boolean };
  unseen: { value: number; capped: boolean };
  observedAt: string;
};
