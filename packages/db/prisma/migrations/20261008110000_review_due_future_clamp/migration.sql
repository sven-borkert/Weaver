-- Repair future due dates left by the never-reviewed backfill without moving already-due reviews.
UPDATE "Document"
SET "reviewDueAt" = LEAST("reviewSince", timezone('UTC', now()))
WHERE "lastReviewedAt" IS NULL
  AND "reviewSince" IS NOT NULL
  AND "reviewDueAt" > timezone('UTC', now());
