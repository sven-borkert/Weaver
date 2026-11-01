/** 950 → "950", 12 340 → "12.3k", 1 048 576 → "1.0M". */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function sessionUsageLine(usage: {
  totals: {
    replies: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}): string {
  const { replies, toolCalls, inputTokens, outputTokens } = usage.totals;
  return [
    plural(replies, "reply").replace("replys", "replies"),
    plural(toolCalls, "tool call"),
    `${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out tokens`,
  ].join(" · ");
}

export function replyUsageLine(run: {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
}): string {
  return [
    run.model,
    run.toolCalls === null ? null : plural(run.toolCalls, "tool call"),
    run.inputTokens === null && run.outputTokens === null
      ? null
      : `${formatTokens(run.inputTokens ?? 0)} in / ${formatTokens(run.outputTokens ?? 0)} out tokens`,
    run.durationMs === null ? null : formatDuration(run.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");
}
