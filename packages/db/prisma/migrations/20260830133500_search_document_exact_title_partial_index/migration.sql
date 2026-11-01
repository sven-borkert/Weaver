-- Ready/current predicates are part of the document exact-title access path,
-- so PostgreSQL can preserve index order and stop at the per-project limit.
DROP INDEX "DocumentIndexState_exact_title_idx";

CREATE INDEX "DocumentIndexState_exact_title_idx"
  ON "DocumentIndexState"
    ("projectId", "exactNormalizedTitleHash", "exactTitle", "documentId")
  WHERE "exactTitle" IS NOT NULL
    AND "status" = 'ready'
    AND "keywordIndexedSha" = "targetSha";
