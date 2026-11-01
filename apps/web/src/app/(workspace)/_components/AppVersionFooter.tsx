"use client";

import { ClientDateTime } from "~/components/ui/client-date";
import { getClientBuildInfo } from "~/lib/buildInfo";
import { cn } from "~/lib/utils";

function buildTitle(
  version: string | null,
  buildTime: string | null,
  commitSha: string | null,
): string {
  const details: string[] = [];
  if (version) details.push(`Version ${version}`);
  if (buildTime) details.push(`Build ${buildTime}`);
  if (commitSha) details.push(`Commit ${commitSha.slice(0, 12)}`);
  return details.join(" | ");
}

export function AppVersionFooter({
  compact = false,
  className,
}: {
  /** The collapsed rail has room for the version only; the timestamp stays in the tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const { version, buildTime, commitSha } = getClientBuildInfo();
  if (!version && !buildTime) return null;
  const built = buildTime ? new Date(buildTime) : null;
  const builtValid = built && !Number.isNaN(built.getTime()) ? built : null;
  const title = buildTitle(version, buildTime, commitSha);

  if (compact) {
    return version ? (
      <div
        className={cn(
          "border-line-faint text-text-3 mono truncate border-t px-1 py-1.5 text-center text-[10px]",
          className,
        )}
        title={title}
      >
        {version}
      </div>
    ) : null;
  }

  return (
    <div
      className={cn("border-line-faint border-t px-3 py-2", className)}
      title={title}
    >
      {version ? (
        <div className="text-text-3 flex min-w-0 items-center justify-between gap-2 text-[11px]">
          <span>Build</span>
          <span className="mono text-text-2 min-w-0 truncate">{version}</span>
        </div>
      ) : null}
      {builtValid ? (
        <div className="text-text-3 truncate text-[10px]">
          Built <ClientDateTime value={builtValid} />
        </div>
      ) : null}
    </div>
  );
}
