-- CreateIndex
CREATE INDEX "Document_projectId_reviewDueAt_id_idx" ON "Document"("projectId", "reviewDueAt", "id");
