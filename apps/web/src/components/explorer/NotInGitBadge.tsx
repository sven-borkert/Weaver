import { GitBranchMinus } from "lucide-react";

import { cn } from "~/lib/utils";

/** Marks Git-ignored content: stored by Weaver but never committed or pushed. */
export function NotInGitBadge({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const label = "Not in Git";
  return (
    <span
      title="Kept out of Git: saved in Weaver, but not committed, versioned or pushed"
      aria-label={compact ? label : undefined}
      className={cn(
        "border-line text-text-3 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium whitespace-nowrap",
        className,
      )}
    >
      <GitBranchMinus aria-hidden="true" className="size-3" />
      {compact ? null : label}
    </span>
  );
}
