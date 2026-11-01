-- Bind every OAuth authorization and refresh family to one immutable consent generation.

UPDATE "OauthConsent"
SET "referenceId" = gen_random_uuid()::text
WHERE "userId" IS NOT NULL
  AND "referenceId" IS NULL;

UPDATE "OauthRefreshToken" AS token
SET "referenceId" = consent."referenceId"
FROM "OauthConsent" AS consent
WHERE token."referenceId" IS NULL
  AND token."userId" = consent."userId"
  AND token."clientId" = consent."clientId"
  AND consent."referenceId" IS NOT NULL;

CREATE INDEX "OauthConsent_userId_clientId_referenceId_idx"
ON "OauthConsent"("userId", "clientId", "referenceId");

CREATE INDEX "OauthRefreshToken_referenceId_idx"
ON "OauthRefreshToken"("referenceId");

CREATE OR REPLACE FUNCTION "weaver_oauth_authorization_lock"(authorization_id TEXT)
RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('weaver:oauth-authorization:' || authorization_id, 0)
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "weaver_assign_oauth_consent_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."referenceId" IS NOT NULL THEN
    NEW."referenceId" := OLD."referenceId";
  ELSIF NEW."referenceId" IS NULL THEN
    NEW."referenceId" := gen_random_uuid()::text;
  END IF;

  PERFORM "weaver_oauth_authorization_lock"(NEW."referenceId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OauthConsent_assign_generation"
BEFORE INSERT OR UPDATE ON "OauthConsent"
FOR EACH ROW EXECUTE FUNCTION "weaver_assign_oauth_consent_generation"();

CREATE OR REPLACE FUNCTION "weaver_bind_oauth_authorization_code"()
RETURNS trigger AS $$
DECLARE
  payload JSONB;
  authorization_id TEXT;
  authorization_user_id TEXT;
  authorization_client_id TEXT;
BEGIN
  BEGIN
    payload := NEW."value"::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN
    RETURN NEW;
  END IF;

  authorization_user_id := payload->>'userId';
  authorization_client_id := payload #>> '{query,client_id}';
  IF authorization_user_id IS NULL OR authorization_client_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT consent."referenceId"
  INTO authorization_id
  FROM "OauthConsent" AS consent
  WHERE consent."userId" = authorization_user_id::uuid
    AND consent."clientId" = authorization_client_id
    AND consent."referenceId" IS NOT NULL
  ORDER BY consent."updatedAt" DESC NULLS LAST,
           consent."createdAt" DESC NULLS LAST,
           consent."id" ASC
  LIMIT 1;

  IF authorization_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM "weaver_oauth_authorization_lock"(authorization_id);
  IF EXISTS (
    SELECT 1
    FROM "OauthConsent" AS consent
    WHERE consent."userId" = authorization_user_id::uuid
      AND consent."clientId" = authorization_client_id
      AND consent."referenceId" = authorization_id
  ) THEN
    payload := jsonb_set(
      payload,
      '{referenceId}',
      to_jsonb(authorization_id),
      true
    );
    NEW."value" := payload::text;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Verification_bind_oauth_authorization_code"
BEFORE INSERT ON "Verification"
FOR EACH ROW EXECUTE FUNCTION "weaver_bind_oauth_authorization_code"();

CREATE OR REPLACE FUNCTION "weaver_validate_oauth_refresh_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."referenceId" IS NULL THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
    RETURN NEW;
  END IF;

  PERFORM "weaver_oauth_authorization_lock"(NEW."referenceId");
  IF NOT EXISTS (
    SELECT 1
    FROM "OauthConsent" AS consent
    WHERE consent."userId" = NEW."userId"
      AND consent."clientId" = NEW."clientId"
      AND consent."referenceId" = NEW."referenceId"
  ) THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OauthRefreshToken_validate_generation"
BEFORE INSERT ON "OauthRefreshToken"
FOR EACH ROW EXECUTE FUNCTION "weaver_validate_oauth_refresh_generation"();
