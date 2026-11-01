-- Discovery pre-fills the suggested effect, so an unreviewed (still disabled) tool may carry one.
ALTER TABLE "ExternalMcpTool" DROP CONSTRAINT "ExternalMcpTool_review_check";
ALTER TABLE "ExternalMcpTool" ADD CONSTRAINT "ExternalMcpTool_review_check" CHECK (
  ("reviewedDefinition" IS NULL AND "reviewedRemoteDigest" IS NULL AND "reviewDigest" IS NULL AND "reviewedAt" IS NULL AND "enabled" = false)
  OR ("reviewedDefinition" IS NOT NULL AND "reviewedRemoteDigest" IS NOT NULL AND "reviewDigest" IS NOT NULL AND "effect" IS NOT NULL AND "reviewedAt" IS NOT NULL)
);
