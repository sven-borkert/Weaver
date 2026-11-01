CREATE INDEX "AiUsage_createdAt_id_idx" ON "AiUsage"("createdAt", "id");
CREATE INDEX "AssistantRunAttempt_endedAt_id_idx" ON "AssistantRunAttempt"("endedAt", "id");
CREATE INDEX "AssistantRunEvent_createdAt_id_idx" ON "AssistantRunEvent"("createdAt", "id");
CREATE INDEX "ScheduledTaskRun_finishedAt_id_idx" ON "ScheduledTaskRun"("finishedAt", "id");
