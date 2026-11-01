export type ChangeSummaryView = {
  status: "pending" | "ready" | "failed" | "skipped";
  summary: string | null;
};

export function changeSummaryMessage(
  message: string,
  view: ChangeSummaryView | null,
): string {
  return view?.status === "ready" && view.summary
    ? `${message} — ${view.summary}`
    : message;
}
