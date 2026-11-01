export type PdfRuntimeStatus =
  { status: "ok" } | { status: "missing"; reason: string };

/** A missing Chromium is re-probed this often, so installing it clears the state without a restart. */
export const PDF_FAILURE_CACHE_MS = 30_000;

// Loaded on demand: importing the renderer validates the server env, which unit tests do not set.
async function probeChromium(): Promise<void> {
  const { launchChromium } = await import("./render");
  const browser = await launchChromium();
  await browser.close();
}

export function createPdfRuntimeCheck(
  deps: { probe: () => Promise<void>; now: () => number } = {
    probe: probeChromium,
    now: Date.now,
  },
): () => Promise<PdfRuntimeStatus> {
  let cached: { result: PdfRuntimeStatus; until: number } | undefined;
  return async () => {
    if (cached && deps.now() < cached.until) return cached.result;
    let result: PdfRuntimeStatus;
    try {
      await deps.probe();
      result = { status: "ok" };
    } catch (error) {
      result = {
        status: "missing",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    cached = {
      result,
      until:
        result.status === "ok"
          ? Number.POSITIVE_INFINITY
          : deps.now() + PDF_FAILURE_CACHE_MS,
    };
    return result;
  };
}

export const checkPdfRuntime = createPdfRuntimeCheck();
