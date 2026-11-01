-- Personal connections: a task input may only use a connection its task owner created.
DELETE FROM "ScheduledTaskExternalInput" AS i
USING "ExternalMcpTool" AS t, "ExternalMcpConnection" AS c, "ScheduledTask" AS s
WHERE i."toolId" = t."id"
  AND t."connectionId" = c."id"
  AND i."taskId" = s."id"
  AND (c."createdById" IS NULL OR c."createdById" <> s."ownerId");

DELETE FROM "ExternalMcpConnection" WHERE "createdById" IS NULL;
