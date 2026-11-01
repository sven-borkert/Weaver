"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { api } from "~/trpc/react";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remembers the project behind the current route; failures are silent by design. */
export function LastOpenedProjectRecorder() {
  const { projectId } = useParams<{ projectId?: string }>();
  const lastRecorded = useRef<string | undefined>(undefined);
  const utils = api.useUtils();
  const record = api.account.recordLastOpenedProject.useMutation({
    onSuccess: () => {
      void utils.account.landingProject.invalidate();
    },
  });
  const mutate = record.mutate;

  useEffect(() => {
    if (!projectId || !UUID_RE.test(projectId)) return;
    if (lastRecorded.current === projectId) return;
    lastRecorded.current = projectId;
    mutate({ projectId }, { onError: () => undefined });
  }, [projectId, mutate]);

  return null;
}
