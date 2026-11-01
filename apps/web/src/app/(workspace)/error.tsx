"use client";

import { Button } from "~/components/ui/button";

export default function WorkspaceError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div role="alert" className="text-text flex flex-col items-start gap-3 p-6">
      <h1 className="text-lg font-semibold">
        This page could not be displayed
      </h1>
      <p>The workspace is still available. Try loading this page again.</p>
      <Button onClick={retry}>Try again</Button>
    </div>
  );
}
