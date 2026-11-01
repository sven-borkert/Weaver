"use client";

import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { api } from "~/trpc/react";

export function MaintainedByTaskBanner({
  projectId,
  documentId,
}: {
  projectId: string;
  documentId: string;
}) {
  const task = api.scheduledTask.byOutputDocument.useQuery({
    projectId,
    documentId,
  });
  if (!task.data) return null;
  return (
    <p
      role="note"
      className="bg-subtle text-text-2 m-0 flex items-center gap-2 rounded-[8px] px-3 py-2 text-[12px]"
    >
      <CalendarClock className="size-4 shrink-0" strokeWidth={1.75} />
      <span>
        Maintained by scheduled task{" "}
        <Link
          href={`/projects/${projectId}/tasks/${task.data.id}`}
          className="font-medium hover:underline"
        >
          {task.data.name}
        </Link>
        {" — "}manual edits are replaced on the next run.
      </span>
    </p>
  );
}
