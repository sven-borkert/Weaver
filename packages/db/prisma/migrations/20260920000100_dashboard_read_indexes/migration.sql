CREATE INDEX "Document_projectId_lastEditedAt_id_idx" ON "Document"("projectId", "lastEditedAt" DESC, "id" DESC);
CREATE INDEX "DataTable_projectId_lastEditedAt_id_idx" ON "DataTable"("projectId", "lastEditedAt" DESC, "id" DESC);
CREATE INDEX "ScheduledTask_ownerId_lastRunAt_id_idx" ON "ScheduledTask"("ownerId", "lastRunAt" DESC, "id" DESC);
