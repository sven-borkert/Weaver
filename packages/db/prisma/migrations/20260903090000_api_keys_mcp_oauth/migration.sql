-- packages/db/prisma/migrations/20260903090000_api_keys_mcp_oauth/migration.sql
-- Phase 4B-2: Better Auth jwt / api-key / oauth-provider (MCP) tables plus the
-- Weaver-owned API-key project restriction (spec §8, §9).

CREATE TABLE "Jwks" (
  "id" UUID NOT NULL,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "alg" TEXT,
  "crv" TEXT,
  CONSTRAINT "Jwks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiKey" (
  "id" UUID NOT NULL,
  "configId" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT,
  "start" TEXT,
  "referenceId" UUID NOT NULL,
  "prefix" TEXT,
  "key" TEXT NOT NULL,
  "refillInterval" INTEGER,
  "refillAmount" INTEGER,
  "lastRefillAt" TIMESTAMP(3),
  "enabled" BOOLEAN DEFAULT true,
  "rateLimitEnabled" BOOLEAN DEFAULT true,
  "rateLimitTimeWindow" INTEGER DEFAULT 86400000,
  "rateLimitMax" INTEGER DEFAULT 10,
  "requestCount" INTEGER DEFAULT 0,
  "remaining" INTEGER,
  "lastRequest" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "permissions" TEXT,
  "metadata" TEXT,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApiKey_configId_idx" ON "ApiKey"("configId");
CREATE INDEX "ApiKey_referenceId_idx" ON "ApiKey"("referenceId");
CREATE INDEX "ApiKey_key_idx" ON "ApiKey"("key");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApiKeyProject" (
  "apiKeyId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  CONSTRAINT "ApiKeyProject_pkey" PRIMARY KEY ("apiKeyId", "projectId")
);
CREATE INDEX "ApiKeyProject_projectId_idx" ON "ApiKeyProject"("projectId");
ALTER TABLE "ApiKeyProject" ADD CONSTRAINT "ApiKeyProject_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKeyProject" ADD CONSTRAINT "ApiKeyProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthClient" (
  "id" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" BOOLEAN DEFAULT false,
  "skipConsent" BOOLEAN,
  "enableEndSession" BOOLEAN,
  "subjectType" TEXT,
  "scopes" TEXT[],
  "clientCredentialsScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "userId" UUID,
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT[],
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT[],
  "postLogoutRedirectUris" TEXT[],
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" BOOLEAN,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" TEXT[],
  "responseTypes" TEXT[],
  "requirePKCE" BOOLEAN,
  "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
  "referenceId" TEXT,
  "metadata" JSONB,
  CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthClient_clientId_key" ON "OauthClient"("clientId");
CREATE INDEX "OauthClient_userId_idx" ON "OauthClient"("userId");
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthResource" (
  "id" UUID NOT NULL,
  "identifier" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT[],
  "customClaims" JSONB,
  "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
  "disabled" BOOLEAN DEFAULT false,
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "policyVersion" INTEGER DEFAULT 1,
  "metadata" JSONB,
  CONSTRAINT "OauthResource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthResource_identifier_key" ON "OauthResource"("identifier");

CREATE TABLE "OauthClientResource" (
  "id" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3),
  CONSTRAINT "OauthClientResource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthClientResource_clientId_resourceId_key" ON "OauthClientResource"("clientId", "resourceId");
CREATE INDEX "OauthClientResource_clientId_idx" ON "OauthClientResource"("clientId");
CREATE INDEX "OauthClientResource_resourceId_idx" ON "OauthClientResource"("resourceId");
ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "OauthResource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthRefreshToken" (
  "id" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "sessionId" UUID,
  "userId" UUID NOT NULL,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT[],
  "requestedUserInfoClaims" TEXT[],
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3),
  "revoked" TIMESTAMP(3),
  "rotatedAt" TIMESTAMP(3),
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" TIMESTAMP(3),
  "authTime" TIMESTAMP(3),
  "confirmation" JSONB,
  "scopes" TEXT[],
  CONSTRAINT "OauthRefreshToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthRefreshToken_token_key" ON "OauthRefreshToken"("token");
CREATE INDEX "OauthRefreshToken_clientId_idx" ON "OauthRefreshToken"("clientId");
CREATE INDEX "OauthRefreshToken_sessionId_idx" ON "OauthRefreshToken"("sessionId");
CREATE INDEX "OauthRefreshToken_userId_idx" ON "OauthRefreshToken"("userId");
CREATE INDEX "OauthRefreshToken_authorizationCodeId_idx" ON "OauthRefreshToken"("authorizationCodeId");
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthAccessToken" (
  "id" UUID NOT NULL,
  "token" TEXT,
  "clientId" TEXT NOT NULL,
  "sessionId" UUID,
  "userId" UUID,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT[],
  "requestedUserInfoClaims" TEXT[],
  "refreshId" UUID,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3),
  "revoked" TIMESTAMP(3),
  "confirmation" JSONB,
  "scopes" TEXT[],
  CONSTRAINT "OauthAccessToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthAccessToken_token_key" ON "OauthAccessToken"("token");
CREATE INDEX "OauthAccessToken_clientId_idx" ON "OauthAccessToken"("clientId");
CREATE INDEX "OauthAccessToken_sessionId_idx" ON "OauthAccessToken"("sessionId");
CREATE INDEX "OauthAccessToken_userId_idx" ON "OauthAccessToken"("userId");
CREATE INDEX "OauthAccessToken_authorizationCodeId_idx" ON "OauthAccessToken"("authorizationCodeId");
CREATE INDEX "OauthAccessToken_refreshId_idx" ON "OauthAccessToken"("refreshId");
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "OauthRefreshToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthConsent" (
  "id" UUID NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" UUID,
  "referenceId" TEXT,
  "resources" TEXT[],
  "requestedUserInfoClaims" TEXT[],
  "scopes" TEXT[],
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OauthConsent_clientId_idx" ON "OauthConsent"("clientId");
CREATE INDEX "OauthConsent_userId_idx" ON "OauthConsent"("userId");
ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthClientAssertion" (
  "id" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OauthClientAssertion_pkey" PRIMARY KEY ("id")
);
