-- Use the generated eligible project key as the exact-title gate, then keep
-- collision verification, deterministic ordering, and join state in one index.
DROP INDEX "DocumentIndexState_exact_title_idx";

CREATE INDEX "DocumentIndexState_exact_title_idx"
  ON "DocumentIndexState"
    (
      "exactNormalizedTitleHash",
      "exactProjectId",
      "exactNormalizedTitle",
      "exactTitle",
      "documentId",
      "targetSha"
    );
