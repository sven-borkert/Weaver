import { describe, expect, it } from "vitest";

import {
  DOCUMENT_INDEX_POLL_MS,
  documentIndexRefetchInterval,
  indexedVersionLabel,
} from "./documentIndex";

const settled = {
  headCommitSha: "a".repeat(40),
  lights: {
    keyword: "ready",
    semantic: "ready",
    graph: "failed",
    summary: null,
  },
  generations: [{ document: { status: "ready" } }, { document: null }],
} as const;

describe("document index polling", () => {
  it("stops once every layer has settled on the shown version", () => {
    expect(documentIndexRefetchInterval(settled, "a".repeat(40))).toBe(false);
    expect(documentIndexRefetchInterval(undefined, "a".repeat(40))).toBe(false);
  });

  it("polls while a layer is pending or a generation is still processing", () => {
    expect(
      documentIndexRefetchInterval(
        { ...settled, lights: { ...settled.lights, keyword: "pending" } },
        "a".repeat(40),
      ),
    ).toBe(DOCUMENT_INDEX_POLL_MS);
    expect(
      documentIndexRefetchInterval(
        {
          ...settled,
          generations: [
            { document: { status: "ready" } },
            { document: { status: "processing" } },
          ],
        },
        "a".repeat(40),
      ),
    ).toBe(DOCUMENT_INDEX_POLL_MS);
  });

  it("polls until the response describes the version on screen", () => {
    expect(documentIndexRefetchInterval(settled, "b".repeat(40))).toBe(
      DOCUMENT_INDEX_POLL_MS,
    );
  });
});

describe("indexed version label", () => {
  it("names the short SHA and whether it is the current version", () => {
    const head = "0123456789abcdef".padEnd(40, "0");
    expect(indexedVersionLabel(head, head)).toBe("0123456 · current");
    expect(indexedVersionLabel("fedcba9".padEnd(40, "0"), head)).toBe(
      "fedcba9 · older version",
    );
    expect(indexedVersionLabel(null, head)).toBe("Not indexed");
  });
});
