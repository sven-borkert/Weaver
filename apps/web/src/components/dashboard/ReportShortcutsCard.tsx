import type { ReportShortcut } from "@weaver/core/dashboard/schema";
import Link from "next/link";
import { ClientDateTime } from "~/components/ui/client-date";
import {
  dashboardDestinationHref,
  workOutcomeLabel,
} from "~/lib/dashboard/presentation";

export function ReportShortcutsCard({ items }: { items: ReportShortcut[] }) {
  return (
    <section
      aria-labelledby="scheduled-reports-heading"
      className="bg-surface border-line rounded-[10px] border p-4"
    >
      <h2
        id="scheduled-reports-heading"
        className="text-text mb-3 text-[14px] font-semibold"
      >
        Scheduled reports
      </h2>
      <Link
        href="/account/tasks"
        className="text-brand-text mb-3 inline-block text-sm hover:underline"
      >
        All tasks
      </Link>
      {items.length ? (
        <div>
          {items.map((item) => (
            <article
              key={item.taskId}
              className="border-line flex flex-col gap-1 border-b py-2 last:border-b-0"
            >
              <Link
                href={dashboardDestinationHref(item.destination)}
                className="text-text text-[13px] font-medium hover:underline"
              >
                {item.title}
              </Link>
              <span className="text-text-3 text-[12px]">
                {item.projectName} ·{" "}
                {item.status === "active" ? "Active" : "Paused"}
              </span>
              <span className="text-text-3 text-[12px]">
                {item.nextRunAt ? (
                  <>
                    Next <ClientDateTime value={new Date(item.nextRunAt)} />
                  </>
                ) : (
                  "No next run scheduled"
                )}
              </span>
              <span className="text-text-3 text-[12px]">
                {item.lastRunStatus
                  ? `Last run: ${workOutcomeLabel(item.lastRunStatus)}`
                  : "Not run yet"}
              </span>
              {item.currentReport ? (
                <Link
                  href={dashboardDestinationHref(item.currentReport)}
                  className="text-brand-text text-[12px] hover:underline"
                >
                  Current report
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-text-3 text-[13px]">No scheduled reports yet.</p>
      )}
    </section>
  );
}
