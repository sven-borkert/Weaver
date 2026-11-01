CREATE TYPE "ProjectPinKind" AS ENUM ('document', 'table');

CREATE TABLE "ProjectContentPin" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" "ProjectPinKind" NOT NULL,
  "resourceId" UUID NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectContentPin_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectContentPin_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectContentPin_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectContentPin_projectId_kind_resourceId_key"
  ON "ProjectContentPin"("projectId", "kind", "resourceId");
CREATE INDEX "ProjectContentPin_projectId_createdAt_id_idx"
  ON "ProjectContentPin"("projectId", "createdAt", "id");
