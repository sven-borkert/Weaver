-- A document that was never reviewed is due as soon as its review clock started.
UPDATE "Document"
SET "reviewDueAt" = "reviewSince"
WHERE "lastReviewedAt" IS NULL AND "reviewSince" IS NOT NULL;
