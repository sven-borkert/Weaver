UPDATE "DiagnosticEvent"
SET "severity" = 'debug'
WHERE "severity" = 'info'
  AND "category" = 'job'
  AND "event" IN ('job.started', 'job.completed')
  AND "details"->>'job' IN (
    'project.git-sync',
    'task.tick',
    'assistant.reconcile'
  );
