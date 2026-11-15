BEGIN;

LOCK TABLE "ScheduledTask" IN SHARE ROW EXCLUSIVE MODE;

-- Preserve every task and report; conflicting owners must be retargeted explicitly.
DO $$
DECLARE
  duplicate_document uuid;
  duplicate_tasks text;
BEGIN
  SELECT "outputDocumentId", string_agg("id"::text, ', ' ORDER BY "id")
    INTO duplicate_document, duplicate_tasks
    FROM "ScheduledTask"
    WHERE "outputDocumentId" IS NOT NULL
    GROUP BY "outputDocumentId"
    HAVING count(*) > 1
    ORDER BY "outputDocumentId"
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Cannot enforce scheduled-task output ownership: document % has tasks %. Retarget the extra tasks and retry this migration; no task data was changed.', duplicate_document, duplicate_tasks;
  END IF;
END $$;

CREATE UNIQUE INDEX "ScheduledTask_outputDocumentId_key" ON "ScheduledTask"("outputDocumentId");
DROP INDEX "ScheduledTask_outputDocumentId_idx";

COMMIT;
