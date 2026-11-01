import { useEffect, useRef } from "react";

/**
 * Closes a locally-owned confirm/entry dialog once its mutation settles
 * (success or error) — the mutation itself lives in the parent page, so a
 * presentational card can only react to the `pending` flag it was handed as
 * a prop. Shared by AccessCard and MembershipsCard.
 */
export function useCloseOnSettle(pending: boolean, close: () => void) {
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) close();
    wasPending.current = pending;
  }, [pending, close]);
}
