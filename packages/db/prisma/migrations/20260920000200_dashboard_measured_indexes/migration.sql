-- The owned shortcut query uses the existing ownerId index before its exact nullable ordering.
DROP INDEX "ScheduledTask_ownerId_lastRunAt_id_idx";
