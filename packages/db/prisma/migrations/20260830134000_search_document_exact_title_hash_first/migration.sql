-- Lead with the request-constant digest so cold planner statistics do not
-- prefer the broader project-only index over the bounded exact-title path.
DROP INDEX "DocumentIndexState_exact_title_idx";

CREATE INDEX "DocumentIndexState_exact_title_idx"
  ON "DocumentIndexState"
    ("exactNormalizedTitleHash", "projectId", "exactTitle", "documentId")
  WHERE "exactTitle" IS NOT NULL
    AND "status" = 'ready'
    AND "keywordIndexedSha" = "targetSha";
