-- Rebuild title headings and restore chunks lost by the former document projection replacement.
UPDATE "DocumentIndexState" AS state
SET "keywordIndexedSha" = NULL,
    "status" = 'pending',
    "completedAt" = NULL,
    "updatedAt" = timezone('UTC', now())
FROM "Document" AS document
JOIN "Project" AS project ON project."id" = document."projectId"
WHERE state."documentId" = document."id"
  AND state."projectId" = document."projectId"
  AND state."status" = 'ready'
  AND project."deletedAt" IS NULL;
