import type { DocumentSectionAnnouncement } from "~/lib/documents/section-navigation";

export function DocumentSectionStatus({
  announcement,
  navigationKey,
}: {
  announcement: DocumentSectionAnnouncement | undefined;
  navigationKey: string | undefined;
}) {
  if (!announcement || announcement.key !== navigationKey) return null;

  return (
    <p
      key={announcement.key}
      role="status"
      className="border-info-border bg-info-bg text-info mb-4 rounded-[6px] border px-3 py-2 text-[12px]"
      aria-live="polite"
      aria-atomic="true"
    >
      {announcement.message}
    </p>
  );
}
