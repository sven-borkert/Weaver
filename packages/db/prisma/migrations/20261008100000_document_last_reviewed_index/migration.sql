-- CreateIndex
CREATE INDEX "Document_lastReviewedAt_idx" ON "Document"("lastReviewedAt");

-- CreateIndex
CREATE INDEX "Document_projectId_lastReviewedAt_id_idx" ON "Document"("projectId", "lastReviewedAt", "id");
