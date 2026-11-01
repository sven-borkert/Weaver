export function createWebRuntimeCleanup(dependencies: {
  stopPublisher: () => Promise<unknown>;
  emitStopped: () => void;
  stopWriter: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  stepTimeoutMs?: number;
}): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return () =>
    (cleanup ??= (async () => {
      let failed = false;
      for (const action of [
        dependencies.stopPublisher,
        dependencies.emitStopped,
        dependencies.stopWriter,
        dependencies.disconnect,
      ]) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(action),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Cleanup timeout")),
                dependencies.stepTimeoutMs ?? 5_000,
              );
            }),
          ]);
        } catch {
          failed = true;
        } finally {
          clearTimeout(timer);
        }
      }
      if (failed) throw new Error("Web runtime cleanup failed");
    })());
}
