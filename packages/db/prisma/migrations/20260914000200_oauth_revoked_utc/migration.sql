-- Keep live trigger timestamps in the UTC wall-clock used by Prisma.
CREATE OR REPLACE FUNCTION "weaver_validate_oauth_access_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."referenceId" IS NULL OR NEW."userId" IS NULL THEN
    NEW."revoked" := COALESCE(NEW."revoked", timezone('UTC', clock_timestamp()));
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
    NEW."revoked" := COALESCE(NEW."revoked", timezone('UTC', clock_timestamp()));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "weaver_validate_oauth_refresh_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."referenceId" IS NULL THEN
    NEW."revoked" := COALESCE(NEW."revoked", timezone('UTC', clock_timestamp()));
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "OauthConsent" AS consent
  WHERE consent."userId" = NEW."userId"
    AND consent."clientId" = NEW."clientId"
    AND consent."referenceId" = NEW."referenceId"
  FOR UPDATE;

  IF NOT FOUND THEN
    NEW."revoked" := COALESCE(NEW."revoked", timezone('UTC', clock_timestamp()));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
