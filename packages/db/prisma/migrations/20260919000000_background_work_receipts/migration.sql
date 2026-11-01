CREATE TYPE "PersonalWorkKind" AS ENUM ('task', 'import', 'assistant');
CREATE TABLE "BackgroundWorkReceipt" (
  "userId" UUID NOT NULL,
  "kind" "PersonalWorkKind" NOT NULL,
  "workId" UUID NOT NULL,
  "revision" VARCHAR(32) NOT NULL CHECK ("revision" ~ '^[a-f0-9]{32}$'),
  "seenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BackgroundWorkReceipt_pkey" PRIMARY KEY ("userId", "kind", "workId", "revision"),
  CONSTRAINT "BackgroundWorkReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BackgroundWorkReceipt_seenAt_idx" ON "BackgroundWorkReceipt"("seenAt");
