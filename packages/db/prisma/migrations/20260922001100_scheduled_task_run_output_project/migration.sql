-- A run's report destination is immutable history: the task's output project can change later.
-- No foreign key: the record must outlive the project.

ALTER TABLE "ScheduledTaskRun"
  ADD COLUMN "outputProjectId" UUID;

UPDATE "ScheduledTaskRun" r
SET "outputProjectId" = d."projectId"
FROM "Document" d
WHERE d."id" = r."outputDocumentId";
