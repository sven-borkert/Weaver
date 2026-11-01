import Link from "next/link";

export function AssistantUnavailable({
  reason,
  isAdmin,
}: {
  reason: "no_route" | "jobs_disabled";
  isAdmin: boolean;
}) {
  return (
    <div className="text-text-2 flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px]">
      <p className="text-text font-medium">
        {reason === "no_route"
          ? "The assistant isn’t set up yet"
          : "The assistant is unavailable right now"}
      </p>
      {reason === "no_route" && isAdmin ? (
        <Link href="/admin/settings/ai" className="text-brand-text underline">
          Configure an assistant model
        </Link>
      ) : (
        <p>Ask an administrator to configure it.</p>
      )}
    </div>
  );
}
