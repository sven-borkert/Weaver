CREATE TABLE "ExamOperation" (
 "userId" UUID NOT NULL,
 "idempotencyKey" VARCHAR(128) NOT NULL,
 "toolName" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL,
 "result" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ExamOperation_pkey" PRIMARY KEY ("userId", "idempotencyKey")
);
CREATE INDEX "ExamOperation_createdAt_idx" ON "ExamOperation"("createdAt");
ALTER TABLE "ExamOperation" ADD CONSTRAINT "ExamOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
