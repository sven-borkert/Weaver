CREATE TABLE "UploadRateLimit" (
  "userId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL,
  CONSTRAINT "UploadRateLimit_pkey" PRIMARY KEY ("userId", "channel"),
  CONSTRAINT "UploadRateLimit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
