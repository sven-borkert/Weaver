CREATE TYPE "ProjectApiTargetKind" AS ENUM ('document', 'documentFolder', 'table', 'tableFolder');
CREATE TYPE "ProjectApiOperationState" AS ENUM ('reserved', 'succeeded', 'failed');

ALTER TABLE "Document" ADD COLUMN "lastEditedByProjectKeyId" UUID, ADD COLUMN "lastEditedByName" TEXT;
ALTER TABLE "DataTable" ADD COLUMN "lastEditedByProjectKeyId" UUID, ADD COLUMN "lastEditedByName" TEXT;
ALTER TABLE "Document" ADD CONSTRAINT "Document_one_last_editor_kind" CHECK ("lastEditedById" IS NULL OR "lastEditedByProjectKeyId" IS NULL);
ALTER TABLE "DataTable" ADD CONSTRAINT "DataTable_one_last_editor_kind" CHECK ("lastEditedById" IS NULL OR "lastEditedByProjectKeyId" IS NULL);

CREATE TABLE "ProjectApiKey" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "createdById" UUID,
  "name" VARCHAR(100) NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(16) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "policyVersion" INTEGER NOT NULL DEFAULT 1,
  "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "ProjectApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectApiKey_limits" CHECK ("policyVersion" > 0 AND "rateLimitPerMinute" BETWEEN 1 AND 10000),
  CONSTRAINT "ProjectApiKey_digest" CHECK ("digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ProjectApiKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectApiKey_digest_key" ON "ProjectApiKey"("digest");
CREATE UNIQUE INDEX "ProjectApiKey_id_projectId_key" ON "ProjectApiKey"("id", "projectId");
CREATE INDEX "ProjectApiKey_projectId_revokedAt_createdAt_idx" ON "ProjectApiKey"("projectId", "revokedAt", "createdAt");
CREATE INDEX "ProjectApiKey_createdById_idx" ON "ProjectApiKey"("createdById");

CREATE TABLE "ProjectApiKeyGrant" (
  "id" UUID NOT NULL,
  "keyId" UUID NOT NULL,
  "targetKind" "ProjectApiTargetKind" NOT NULL,
  "targetId" UUID,
  "isScopeRoot" BOOLEAN NOT NULL DEFAULT false,
  "canRead" BOOLEAN NOT NULL DEFAULT false,
  "canCreate" BOOLEAN NOT NULL DEFAULT false,
  "canUpdate" BOOLEAN NOT NULL DEFAULT false,
  "canDelete" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "ProjectApiKeyGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectApiKeyGrant_target" CHECK (("isScopeRoot" AND "targetId" IS NULL AND "targetKind" IN ('documentFolder', 'tableFolder')) OR (NOT "isScopeRoot" AND "targetId" IS NOT NULL)),
  CONSTRAINT "ProjectApiKeyGrant_actions" CHECK (("canRead" OR "canCreate" OR "canUpdate" OR "canDelete") AND NOT ("targetKind" = 'document' AND "canCreate")),
  CONSTRAINT "ProjectApiKeyGrant_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ProjectApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectApiKeyGrant_keyId_targetKind_targetId_key" ON "ProjectApiKeyGrant"("keyId", "targetKind", "targetId");
CREATE UNIQUE INDEX "ProjectApiKeyGrant_root_key" ON "ProjectApiKeyGrant"("keyId", "targetKind") WHERE "isScopeRoot";
CREATE INDEX "ProjectApiKeyGrant_keyId_idx" ON "ProjectApiKeyGrant"("keyId");

CREATE TABLE "ProjectApiOperation" (
  "id" UUID NOT NULL,
  "keyId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "operation" VARCHAR(40) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "state" "ProjectApiOperationState" NOT NULL DEFAULT 'reserved',
  "resourceId" UUID,
  "generatedIds" JSONB NOT NULL,
  "authorizingAnchors" JSONB NOT NULL,
  "commitSha" VARCHAR(40),
  "receipt" JSONB,
  "error" JSONB,
  "httpStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ProjectApiOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectApiOperation_hash" CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ProjectApiOperation_state" CHECK (
    ("state" = 'reserved' AND "completedAt" IS NULL AND "commitSha" IS NULL AND "receipt" IS NULL AND "error" IS NULL) OR
    ("state" = 'succeeded' AND "completedAt" IS NOT NULL AND "commitSha" ~ '^[a-f0-9]{40}$' AND "receipt" IS NOT NULL AND "error" IS NULL) OR
    ("state" = 'failed' AND "completedAt" IS NOT NULL AND "commitSha" IS NULL AND "receipt" IS NULL AND "error" IS NOT NULL)
  ),
  CONSTRAINT "ProjectApiOperation_keyId_projectId_fkey" FOREIGN KEY ("keyId", "projectId") REFERENCES "ProjectApiKey"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectApiOperation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectApiOperation_keyId_idempotencyKey_key" ON "ProjectApiOperation"("keyId", "idempotencyKey");
CREATE INDEX "ProjectApiOperation_keyId_projectId_idx" ON "ProjectApiOperation"("keyId", "projectId");
CREATE INDEX "ProjectApiOperation_projectId_state_createdAt_idx" ON "ProjectApiOperation"("projectId", "state", "createdAt");
CREATE INDEX "ProjectApiOperation_state_completedAt_idx" ON "ProjectApiOperation"("state", "completedAt");

CREATE TABLE "ProjectApiAuditEvent" (
  "id" UUID NOT NULL,
  "keyId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "requestId" VARCHAR(64) NOT NULL,
  "method" VARCHAR(8) NOT NULL,
  "operation" VARCHAR(40) NOT NULL,
  "resourceId" UUID,
  "outcome" VARCHAR(40) NOT NULL,
  "status" INTEGER NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "commitSha" VARCHAR(40),
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectApiAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectApiAuditEvent_status" CHECK ("status" BETWEEN 100 AND 599 AND "durationMs" >= 0),
  CONSTRAINT "ProjectApiAuditEvent_keyId_projectId_fkey" FOREIGN KEY ("keyId", "projectId") REFERENCES "ProjectApiKey"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectApiAuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectApiAuditEvent_keyId_projectId_idx" ON "ProjectApiAuditEvent"("keyId", "projectId");
CREATE INDEX "ProjectApiAuditEvent_projectId_createdAt_idx" ON "ProjectApiAuditEvent"("projectId", "createdAt");
CREATE INDEX "ProjectApiAuditEvent_createdAt_idx" ON "ProjectApiAuditEvent"("createdAt");

CREATE TABLE "ProjectApiRateWindow" (
  "keyId" UUID NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "requestCount" INTEGER NOT NULL,
  CONSTRAINT "ProjectApiRateWindow_pkey" PRIMARY KEY ("keyId"),
  CONSTRAINT "ProjectApiRateWindow_count" CHECK ("requestCount" > 0),
  CONSTRAINT "ProjectApiRateWindow_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ProjectApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectApiRateWindow_windowStartedAt_idx" ON "ProjectApiRateWindow"("windowStartedAt");
