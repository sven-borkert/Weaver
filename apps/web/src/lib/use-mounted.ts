import { useSyncExternalStore } from "react";

const subscribeNoop = () => () => undefined;
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}
