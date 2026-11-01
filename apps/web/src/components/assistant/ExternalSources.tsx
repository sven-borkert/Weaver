"use client";
import type { ExternalSource } from "@weaver/core/externalMcp/types";
export function ExternalSources({ sources }: { sources: ExternalSource[] }) {
  if (!sources.length) return null;
  return (
    <section
      aria-label="External sources"
      className="border-line rounded border p-2 text-[12px]"
    >
      <p className="text-text font-medium">External sources</p>
      <ul>
        {sources.map((source) => (
          <li key={source.callId}>
            {source.connectionName || "Unavailable connection"} ·{" "}
            {source.toolName || "External tool"} · Retrieved{" "}
            <time dateTime={source.retrievedAt}>{source.retrievedAt}</time>
            {source.truncated ? " · Result truncated" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
