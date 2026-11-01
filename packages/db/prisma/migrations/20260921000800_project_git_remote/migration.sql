CREATE TABLE "ProjectGitRemote" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "remoteUrl" VARCHAR(2048) NOT NULL,
  "branch" VARCHAR(255) NOT NULL DEFAULT 'main',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "keyName" VARCHAR(120),
  "keyFingerprint" VARCHAR(100),
  "keyUploadedAt" TIMESTAMP(3),
  "credentialCiphertext" BYTEA,
  "credentialNonce" BYTEA,
  "credentialTag" BYTEA,
  "credentialKeyVersion" INTEGER,
  "knownHosts" TEXT,
  "lastPushedSha" VARCHAR(40),
  "lastPushedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(40),
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "queueToken" UUID,
  "queuedAt" TIMESTAMP(3),
  "leaseToken" UUID,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGitRemote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectGitRemote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGitRemote_key_consistent" CHECK (
    ("credentialCiphertext" IS NULL AND "credentialNonce" IS NULL AND "credentialTag" IS NULL AND "credentialKeyVersion" IS NULL AND "keyName" IS NULL AND "keyFingerprint" IS NULL AND "keyUploadedAt" IS NULL)
    OR ("credentialCiphertext" IS NOT NULL AND "credentialNonce" IS NOT NULL AND "credentialTag" IS NOT NULL AND "credentialKeyVersion" IS NOT NULL AND "keyName" IS NOT NULL AND "keyFingerprint" IS NOT NULL AND "keyUploadedAt" IS NOT NULL)
  ),
  CONSTRAINT "ProjectGitRemote_enabled_key" CHECK (NOT "enabled" OR "credentialCiphertext" IS NOT NULL)
);
CREATE UNIQUE INDEX "ProjectGitRemote_projectId_key" ON "ProjectGitRemote"("projectId");
CREATE INDEX "ProjectGitRemote_enabled_nextAttemptAt_idx" ON "ProjectGitRemote"("enabled", "nextAttemptAt");
