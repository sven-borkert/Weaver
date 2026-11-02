CREATE TABLE "ProjectWikiSettings" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabledById" UUID,
    "enabledAt" TIMESTAMP(3),
    "agentId" UUID,
    "guideDocumentId" UUID,
    "approvedGuideDigest" VARCHAR(64),
    "approvedGuideBody" TEXT,
    "approvedGuideCommitSha" VARCHAR(40),
    "approvedGuideAt" TIMESTAMP(3),
    "approvedGuideById" UUID,
    "sourcesFolderId" UUID,
    "sourceTablesFolderId" UUID,
    "overviewDocumentId" UUID,
    "reportDocumentId" UUID,
    "lintSchedule" JSONB,
    "lintTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "lintCron" TEXT,
    "lintNextRunAt" TIMESTAMP(3),
    "lintConsecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lintPausedAt" TIMESTAMP(3),
    "destructiveBudget24h" INTEGER NOT NULL DEFAULT 100000,
    "destructivePausedAt" TIMESTAMP(3),
    "spendAlertCentsPerDay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectWikiSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectWikiSettings_guide_body_size" CHECK ("approvedGuideBody" IS NULL OR octet_length("approvedGuideBody") <= 16000),
    CONSTRAINT "ProjectWikiSettings_approval_complete" CHECK (("approvedGuideBody" IS NULL) = ("approvedGuideDigest" IS NULL))
);

CREATE UNIQUE INDEX "ProjectWikiSettings_projectId_key" ON "ProjectWikiSettings"("projectId");
CREATE INDEX "ProjectWikiSettings_agentId_idx" ON "ProjectWikiSettings"("agentId");
CREATE INDEX "ProjectWikiSettings_enabled_lintNextRunAt_idx" ON "ProjectWikiSettings"("enabled", "lintNextRunAt");

ALTER TABLE "ProjectWikiSettings" ADD CONSTRAINT "ProjectWikiSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWikiSettings" ADD CONSTRAINT "ProjectWikiSettings_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "WikiAgent"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "WikiGuideSuggestion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runId" UUID,
    "text" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,

    CONSTRAINT "WikiGuideSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WikiGuideSuggestion_projectId_resolvedAt_idx" ON "WikiGuideSuggestion"("projectId", "resolvedAt");
CREATE INDEX "WikiGuideSuggestion_runId_idx" ON "WikiGuideSuggestion"("runId");

ALTER TABLE "WikiGuideSuggestion" ADD CONSTRAINT "WikiGuideSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
