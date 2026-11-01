UPDATE "ProjectApiOperation"
SET "state" = 'reserved', "receipt" = NULL, "completedAt" = NULL, "httpStatus" = NULL
WHERE "state" = 'succeeded' AND "commitSha" IS NULL;

ALTER TABLE "ProjectApiOperation" DROP CONSTRAINT "ProjectApiOperation_state";
ALTER TABLE "ProjectApiOperation" ADD CONSTRAINT "ProjectApiOperation_state" CHECK (
  ("state" = 'reserved' AND "completedAt" IS NULL AND "commitSha" IS NULL AND "receipt" IS NULL AND "error" IS NULL) OR
  ("state" = 'succeeded' AND "completedAt" IS NOT NULL AND "commitSha" IS NOT NULL AND "commitSha" ~ '^[a-f0-9]{40}$' AND "receipt" IS NOT NULL AND "error" IS NULL) OR
  ("state" = 'failed' AND "completedAt" IS NOT NULL AND "commitSha" IS NULL AND "receipt" IS NULL AND "error" IS NOT NULL)
);
