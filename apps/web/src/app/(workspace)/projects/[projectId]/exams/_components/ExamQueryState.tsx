"use client";
import NotFound from "~/app/not-found";
import { Button } from "~/components/ui/button";
import { isQueryAccessError } from "~/lib/query-presentation";
export function ExamQueryState({
  loading,
  error,
  retry,
}: {
  loading?: boolean;
  error?: unknown;
  retry: () => void;
}) {
  if (isQueryAccessError(error)) return <NotFound />;
  return (
    <div role={error ? "alert" : "status"} className="p-6">
      {loading ? (
        "Loading…"
      ) : (
        <>
          Could not load exams. <Button onClick={retry}>Retry</Button>
        </>
      )}
    </div>
  );
}
