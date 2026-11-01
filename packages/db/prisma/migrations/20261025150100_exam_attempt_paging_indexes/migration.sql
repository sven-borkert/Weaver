BEGIN;
CREATE INDEX "ExamAttempt_projectId_startedAt_id_idx" ON "ExamAttempt" ("projectId", "startedAt" DESC, "id" DESC);
CREATE INDEX "ExamAttempt_projectId_examId_startedAt_id_idx" ON "ExamAttempt" ("projectId", "examId", "startedAt" DESC, "id" DESC);
COMMIT;
