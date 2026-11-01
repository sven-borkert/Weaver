-- Unreviewed tools discovered before effects were pre-filled get the suggestion discovery now keeps current.
UPDATE "ExternalMcpTool" SET "effect" = CASE WHEN "discoveredDefinition"->'annotations'->'readOnlyHint' = 'true'::jsonb THEN 'read'::"ExternalMcpToolEffect" ELSE 'write'::"ExternalMcpToolEffect" END WHERE "reviewedRemoteDigest" IS NULL AND "effect" IS NULL;
