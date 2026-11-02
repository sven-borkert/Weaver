CREATE TABLE "WikiAgent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Wiki agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WikiAgent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WikiAgent_projectId_idx" ON "WikiAgent"("projectId");
CREATE UNIQUE INDEX "WikiAgent_one_live_per_project" ON "WikiAgent"("projectId") WHERE "revokedAt" IS NULL;

ALTER TABLE "WikiAgent" ADD CONSTRAINT "WikiAgent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
