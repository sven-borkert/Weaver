CREATE INDEX "ScheduledTaskRun_taskId_finishedAt_id_idx"
  ON "ScheduledTaskRun" ("taskId", "finishedAt" DESC, "id" DESC);
CREATE INDEX "IngestionBatch_createdById_id_idx"
  ON "IngestionBatch" ("createdById", "id");
CREATE INDEX "IngestionFile_batchId_createdAt_id_idx"
  ON "IngestionFile" ("batchId", "createdAt" DESC, "id" DESC);
CREATE INDEX "AssistantRun_conversationId_finishedAt_id_idx"
  ON "AssistantRun" ("conversationId", "finishedAt" DESC, "id" DESC);
CREATE INDEX "KnowledgeGeneration_projectId_createdAt_id_idx"
  ON "KnowledgeGeneration" ("projectId", "createdAt" DESC, "id" DESC);
