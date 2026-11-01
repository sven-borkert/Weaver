"use client";

import { useParams } from "next/navigation";
import { api } from "~/trpc/react";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route's project, or the stored last-opened project on global routes. */
export function useActiveProjectId(): {
  projectId: string | null;
  fromRoute: boolean;
} {
  const params = useParams<{ projectId?: string }>();
  const routeId =
    params.projectId && UUID_RE.test(params.projectId)
      ? params.projectId
      : null;
  const landing = api.account.landingProject.useQuery(undefined, {
    enabled: routeId === null,
    staleTime: 60_000,
  });
  if (routeId) return { projectId: routeId, fromRoute: true };
  return { projectId: landing.data?.projectId ?? null, fromRoute: false };
}
