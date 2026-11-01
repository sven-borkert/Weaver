CREATE TABLE "RemoteInstance" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "baseUrl" VARCHAR(2048) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastCheckedAt" TIMESTAMP(3),
  "checkStatus" VARCHAR(40),
  "checkErrorSummary" VARCHAR(300),
  CONSTRAINT "RemoteInstance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemoteInstance_revision_check" CHECK ("revision" >= 1)
);
CREATE UNIQUE INDEX "RemoteInstance_name_key" ON "RemoteInstance"("name");
CREATE UNIQUE INDEX "RemoteInstance_baseUrl_key" ON "RemoteInstance"("baseUrl");
CREATE INDEX "RemoteInstance_createdById_idx" ON "RemoteInstance"("createdById");
CREATE INDEX "RemoteInstance_enabled_idx" ON "RemoteInstance"("enabled");
ALTER TABLE "RemoteInstance" ADD CONSTRAINT "RemoteInstance_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RemoteInstanceConnection" (
  "id" UUID NOT NULL,
  "remoteInstanceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "remoteUserId" VARCHAR(64),
  "remoteUserName" VARCHAR(200),
  "tokensCiphertext" TEXT NOT NULL,
  "tokensKeyVersion" INTEGER NOT NULL,
  "tokensIv" TEXT NOT NULL,
  "tokensTag" TEXT NOT NULL,
  "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "scope" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "RemoteInstanceConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RemoteInstanceConnection_remoteInstanceId_userId_key"
  ON "RemoteInstanceConnection"("remoteInstanceId", "userId");
CREATE INDEX "RemoteInstanceConnection_userId_idx" ON "RemoteInstanceConnection"("userId");
ALTER TABLE "RemoteInstanceConnection" ADD CONSTRAINT "RemoteInstanceConnection_remoteInstanceId_fkey"
  FOREIGN KEY ("remoteInstanceId") REFERENCES "RemoteInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteInstanceConnection" ADD CONSTRAINT "RemoteInstanceConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RemoteInstanceAuthorization" (
  "state" VARCHAR(64) NOT NULL,
  "remoteInstanceId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "codeVerifier" VARCHAR(128) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RemoteInstanceAuthorization_pkey" PRIMARY KEY ("state")
);
CREATE INDEX "RemoteInstanceAuthorization_userId_idx" ON "RemoteInstanceAuthorization"("userId");
CREATE INDEX "RemoteInstanceAuthorization_expiresAt_idx" ON "RemoteInstanceAuthorization"("expiresAt");
ALTER TABLE "RemoteInstanceAuthorization" ADD CONSTRAINT "RemoteInstanceAuthorization_remoteInstanceId_fkey"
  FOREIGN KEY ("remoteInstanceId") REFERENCES "RemoteInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RemoteInstanceAuthorization" ADD CONSTRAINT "RemoteInstanceAuthorization_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
