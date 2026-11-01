import { FolderDown } from "lucide-react";

import { buttonVariants } from "~/components/ui/button";

/** Downloads the open folder (or the project root) as a ZIP archive. */
export function FolderDownloadButton({
  href,
  folderName,
}: {
  href: string;
  folderName: string;
}) {
  return (
    <a
      href={href}
      download
      aria-label={`Download ${folderName} as ZIP`}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <FolderDown data-icon="inline-start" aria-hidden="true" />
      Download as ZIP
    </a>
  );
}
