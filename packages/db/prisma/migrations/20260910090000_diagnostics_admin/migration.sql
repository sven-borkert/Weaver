-- Admin MCP diagnostics: shared settings and the diagnostic log (design §4).

CREATE TYPE "DiagnosticRuntime" AS ENUM ('web', 'worker', 'mcp');
CREATE TYPE "DiagnosticSeverity" AS ENUM ('debug', 'info', 'warn', 'error');

CREATE TABLE "SystemSetting" (
  "key" VARCHAR(80) NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" UUID,
  CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "DiagnosticEvent" (
  "id" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runtime" "DiagnosticRuntime" NOT NULL,
  "severity" "DiagnosticSeverity" NOT NULL,
  "verbose" BOOLEAN NOT NULL DEFAULT false,
  "category" VARCHAR(40) NOT NULL,
  "event" VARCHAR(80) NOT NULL,
  "message" VARCHAR(500) NOT NULL,
  "requestId" VARCHAR(64),
  "jobId" VARCHAR(64),
  "runId" UUID,
  "userId" UUID,
  "credentialId" VARCHAR(200),
  "projectId" UUID,
  "generationId" UUID,
  "documentId" UUID,
  "connectionId" UUID,
  "durationMs" INTEGER,
  "statusCode" INTEGER,
  "outcome" VARCHAR(20),
  "details" JSONB,
  "hasRequestBody" BOOLEAN NOT NULL DEFAULT false,
  "hasResponseBody" BOOLEAN NOT NULL DEFAULT false,
  "requestBody" TEXT,
  "responseBody" TEXT,
  CONSTRAINT "DiagnosticEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DiagnosticEvent_createdAt_idx" ON "DiagnosticEvent"("createdAt");
CREATE INDEX "DiagnosticEvent_category_createdAt_idx" ON "DiagnosticEvent"("category", "createdAt");
CREATE INDEX "DiagnosticEvent_jobId_idx" ON "DiagnosticEvent"("jobId");
CREATE INDEX "DiagnosticEvent_runId_idx" ON "DiagnosticEvent"("runId");
CREATE INDEX "DiagnosticEvent_requestId_idx" ON "DiagnosticEvent"("requestId");
CREATE INDEX "DiagnosticEvent_projectId_createdAt_idx" ON "DiagnosticEvent"("projectId", "createdAt");
CREATE INDEX "DiagnosticEvent_generationId_idx" ON "DiagnosticEvent"("generationId");
CREATE INDEX "DiagnosticEvent_verbose_createdAt_idx" ON "DiagnosticEvent"("verbose", "createdAt");
