CREATE TABLE "UploadReservation" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "bytes" BIGINT NOT NULL CHECK ("bytes" >= 0),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UploadReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UploadReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UploadReservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UploadReservation_userId_expiresAt_idx" ON "UploadReservation"("userId", "expiresAt");
CREATE INDEX "UploadReservation_projectId_expiresAt_idx" ON "UploadReservation"("projectId", "expiresAt");
CREATE INDEX "UploadReservation_expiresAt_idx" ON "UploadReservation"("expiresAt");
