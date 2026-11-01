-- Existing projects keep header version 2 so the upgrade pass adds review blocks; new projects start current.
ALTER TABLE "Project" ALTER COLUMN "documentHeaderVersion" SET DEFAULT 3;
ALTER TABLE "Project" ADD COLUMN "defaultReviewEveryMonths" INTEGER NOT NULL DEFAULT 12;

ALTER TABLE "Document"
  ADD COLUMN "reviewEveryMonths" INTEGER,
  ADD COLUMN "reviewSince" TIMESTAMP(3),
  ADD COLUMN "lastReviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" UUID,
  ADD COLUMN "reviewedByName" TEXT,
  ADD COLUMN "reviewDueAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD CONSTRAINT "Document_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Document_reviewDueAt_idx" ON "Document"("reviewDueAt");
CREATE INDEX "Document_reviewedById_idx" ON "Document"("reviewedById");

CREATE TABLE "ReviewerGroup" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewerGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReviewerGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReviewerGroup_projectId_name_key" ON "ReviewerGroup"("projectId", "name");

CREATE TABLE "ReviewerGroupMember" (
  "groupId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  CONSTRAINT "ReviewerGroupMember_pkey" PRIMARY KEY ("groupId", "userId"),
  CONSTRAINT "ReviewerGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ReviewerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReviewerGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReviewerGroupMember_userId_idx" ON "ReviewerGroupMember"("userId");

CREATE TABLE "ProjectDefaultReviewer" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" UUID,
  "groupId" UUID,
  CONSTRAINT "ProjectDefaultReviewer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectDefaultReviewer_one_target" CHECK (("userId" IS NULL) <> ("groupId" IS NULL)),
  CONSTRAINT "ProjectDefaultReviewer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectDefaultReviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectDefaultReviewer_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ReviewerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProjectDefaultReviewer_projectId_userId_key" ON "ProjectDefaultReviewer"("projectId", "userId");
CREATE UNIQUE INDEX "ProjectDefaultReviewer_projectId_groupId_key" ON "ProjectDefaultReviewer"("projectId", "groupId");

CREATE TABLE "DocumentReviewer" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "refId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "userId" UUID,
  "groupId" UUID,
  CONSTRAINT "DocumentReviewer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentReviewer_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentReviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DocumentReviewer_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ReviewerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DocumentReviewer_documentId_type_refId_key" ON "DocumentReviewer"("documentId", "type", "refId");
CREATE INDEX "DocumentReviewer_userId_idx" ON "DocumentReviewer"("userId");
CREATE INDEX "DocumentReviewer_groupId_idx" ON "DocumentReviewer"("groupId");

-- Every current Owner is a default reviewer of their existing project.
INSERT INTO "ProjectDefaultReviewer" ("id", "projectId", "userId")
SELECT gen_random_uuid(), p."id", m."userId"
FROM "Project" p
JOIN "Member" m ON m."organizationId" = p."organizationId" AND m."role" = 'owner';
