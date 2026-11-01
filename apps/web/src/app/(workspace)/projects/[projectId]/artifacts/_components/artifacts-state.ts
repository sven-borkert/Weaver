import type { QueryPresentation } from "~/lib/query-presentation";

/** Which block the list area renders for the current query state. */
export type ArtifactsListBody = "loading" | "hidden" | "no-matches" | "table";

export function artifactsListBody(
  presentation: QueryPresentation,
  searchActive: boolean,
  itemCount: number,
): ArtifactsListBody {
  if (presentation === "loading") return "loading";
  if (presentation === "error") return "hidden";
  if (searchActive && itemCount === 0) return "no-matches";
  return "table";
}

/** Deleting the last row of a later page leaves that page empty. */
export function pageAfterDelete(page: number, rowsOnPage: number): number {
  return page > 1 && rowsOnPage <= 1 ? page - 1 : page;
}

/** A page beyond the server's last one (rows deleted elsewhere) snaps back. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount));
}
