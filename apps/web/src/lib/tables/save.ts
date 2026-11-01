import {
  draftFromSnapshot,
  snapshotFromWrite,
  type TableDraft,
  type TableSnapshot,
} from "./draft";
import type { TableData } from "@weaver/core/tables/types";

export type AcceptedTableWriteState = {
  snapshot: TableSnapshot;
  draft: TableDraft;
  staleIncomingBaseCommitSha: string | undefined;
};

export function acceptedTableWriteState(
  result: TableData & { headCommitSha: string },
  staleIncomingBaseCommitSha: string | undefined,
): AcceptedTableWriteState {
  const snapshot = snapshotFromWrite(result);
  return {
    snapshot,
    draft: draftFromSnapshot(snapshot),
    staleIncomingBaseCommitSha,
  };
}

export async function refreshAfterAcceptedTableWrite(
  refresh: () => Promise<unknown>,
): Promise<"refreshed" | "failed"> {
  try {
    await refresh();
    return "refreshed";
  } catch {
    return "failed";
  }
}
