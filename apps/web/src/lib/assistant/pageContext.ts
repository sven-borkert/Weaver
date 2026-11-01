import { useParams, usePathname } from "next/navigation";
import type { PageContext } from "./scopeDraft";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROJECT_ROUTE = new RegExp(
  `^/projects/(${UUID})(?:/(documents|tables)/(${UUID}))?(?:/|$)`,
  "i",
);

/** Parses `/projects/:projectId(/documents|tables/:resourceId)?` from a raw path. */
export function pageContextFromPath(pathname: string): PageContext {
  const match = PROJECT_ROUTE.exec(pathname);
  if (!match) return {};
  const [, projectId, area, resourceId] = match;
  if (area === "documents" && resourceId)
    return { projectId: projectId!, documentId: resourceId };
  if (area === "tables" && resourceId)
    return { projectId: projectId!, tableId: resourceId };
  return { projectId: projectId! };
}

export function usePageContext(): PageContext {
  const pathname = usePathname();
  // useParams keeps the hook reactive to route changes inside the same segment.
  useParams();
  return pageContextFromPath(pathname);
}
