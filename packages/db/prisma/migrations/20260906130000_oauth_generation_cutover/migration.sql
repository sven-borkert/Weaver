-- Make the irrecoverable legacy boundary a lock-protected, timestamp-free cutover.

BEGIN;

LOCK TABLE
  "OauthConsent",
  "OauthRefreshToken",
  "OauthAccessToken"
IN SHARE MODE;

CREATE TEMP TABLE "_weaver_oauth_cutover_generations" ON COMMIT DROP AS
SELECT "id", "referenceId"
FROM "OauthConsent";

DROP TRIGGER "OauthConsent_assign_generation" ON "OauthConsent";

UPDATE "OauthConsent" AS consent
SET "referenceId" = gen_random_uuid()::text
FROM "_weaver_oauth_cutover_generations" AS cutover
WHERE consent."id" = cutover."id";

CREATE TRIGGER "OauthConsent_assign_generation"
BEFORE INSERT OR UPDATE ON "OauthConsent"
FOR EACH ROW EXECUTE FUNCTION "weaver_assign_oauth_consent_generation"();

UPDATE "OauthRefreshToken"
SET "revoked" = COALESCE("revoked", clock_timestamp());

UPDATE "OauthAccessToken"
SET "revoked" = COALESCE("revoked", clock_timestamp());

CREATE OR REPLACE FUNCTION "weaver_validate_oauth_access_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."referenceId" IS NULL OR NEW."userId" IS NULL THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "OauthConsent" AS consent
  WHERE consent."userId" = NEW."userId"
    AND consent."clientId" = NEW."clientId"
    AND consent."referenceId" = NEW."referenceId"
    AND consent."scopes" @> NEW."scopes"
    AND consent."resources" @> NEW."resources"
  FOR UPDATE;

  IF NOT FOUND THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "OauthAccessToken_validate_generation"
ON "OauthAccessToken";

CREATE TRIGGER "OauthAccessToken_validate_generation"
BEFORE INSERT ON "OauthAccessToken"
FOR EACH ROW EXECUTE FUNCTION "weaver_validate_oauth_access_generation"();

COMMIT;
