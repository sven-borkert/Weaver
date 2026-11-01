ALTER TABLE "EntityMention" ADD COLUMN "sourceDescription" TEXT;

CREATE INDEX "EntityMention_current_description_idx"
ON "EntityMention" ("projectId", "generationId", "entityId")
WHERE "invalidatedAt" IS NULL AND "sourceDescription" IS NOT NULL;
