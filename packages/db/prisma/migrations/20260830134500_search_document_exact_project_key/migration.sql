-- Keep exact-title authorization on a dedicated generated key so the broad
-- project-state index cannot displace the bounded exact access path.
ALTER TABLE "DocumentIndexState"
  ADD COLUMN "exactProjectId" UUID
  GENERATED ALWAYS AS (
    CASE
      WHEN "exactTitle" IS NOT NULL
       AND "status" = 'ready'
       AND "keywordIndexedSha" = "targetSha"
      THEN "projectId"
    END
  ) STORED;

DROP INDEX "DocumentIndexState_exact_title_idx";

CREATE INDEX "DocumentIndexState_exact_title_idx"
  ON "DocumentIndexState"
    ("exactNormalizedTitleHash", "exactProjectId", "exactTitle", "documentId")
  WHERE "exactProjectId" IS NOT NULL;
