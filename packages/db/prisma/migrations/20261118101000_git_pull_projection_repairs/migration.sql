ALTER TABLE "Project"
    ADD COLUMN "gitDocumentRepairToken" UUID,
    ADD COLUMN "gitTableRepairToken" UUID;

CREATE INDEX "Project_git_projection_repair_pending_idx"
    ON "Project" ("id")
    WHERE "deletedAt" IS NULL
        AND ("gitDocumentRepairToken" IS NOT NULL OR "gitTableRepairToken" IS NOT NULL);
