ALTER TABLE "ProjectGitRemote"
  ADD COLUMN "pullQueueToken" UUID,
  ADD COLUMN "pullRequestedAt" TIMESTAMP(3),
  ADD COLUMN "pullRequestedById" UUID,
  ADD COLUMN "lastPullSha" VARCHAR(40),
  ADD COLUMN "lastPullAt" TIMESTAMP(3),
  ADD COLUMN "lastPullErrorCode" VARCHAR(40);
