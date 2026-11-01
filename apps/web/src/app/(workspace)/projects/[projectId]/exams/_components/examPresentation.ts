export const EXAM_STATUS_LABELS = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};
export const ATTEMPT_STATUS_LABELS = {
  in_progress: "In progress",
  submitted: "Waiting for grading",
  in_review: "Being graded",
  released: "Graded",
};
export const GRADED_VIA_LABELS: Record<string, string> = {
  session: "in Weaver",
  apiKey: "via API key",
  oauth: "via connected app",
  assistant: "by the assistant",
};
export function formatRemaining(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m < 60
    ? `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export type TraineeExamState =
  "not_started" | "in_progress" | "waiting" | "graded" | "closed";
export function traineeExamState(exam: {
  status: string;
  attempts: readonly { status: string }[];
}): TraineeExamState {
  const a = exam.attempts[0];
  if (a?.status === "in_progress") return "in_progress";
  if (exam.status === "archived") return "closed";
  if (!a) return "not_started";
  return a.status === "released" ? "graded" : "waiting";
}
export function scoreLabel(a: {
  totalScore: number | null;
  maxScore: number;
  percent: number | null;
  passed: boolean | null;
}) {
  return `${a.totalScore ?? "—"} / ${a.maxScore} (${a.percent ?? "—"} %)${a.passed === null ? "" : a.passed ? " · passed" : " · not passed"}`;
}
