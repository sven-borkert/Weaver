-- Make one consent row the serialization point for each live OAuth grant.

CREATE TEMP TABLE "_weaver_duplicate_oauth_consents" AS
SELECT "id", "referenceId"
FROM (
  SELECT
    consent."id",
    consent."referenceId",
    row_number() OVER (
      PARTITION BY consent."userId", consent."clientId"
      ORDER BY consent."updatedAt" DESC NULLS LAST,
               consent."createdAt" DESC NULLS LAST,
               consent."id" ASC
    ) AS position
  FROM "OauthConsent" AS consent
  WHERE consent."userId" IS NOT NULL
) AS ranked
WHERE ranked.position > 1;

UPDATE "OauthRefreshToken" AS token
SET "revoked" = COALESCE(token."revoked", clock_timestamp())
FROM "_weaver_duplicate_oauth_consents" AS duplicate
WHERE duplicate."referenceId" IS NOT NULL
  AND token."referenceId" = duplicate."referenceId";

UPDATE "OauthAccessToken" AS token
SET "revoked" = COALESCE(token."revoked", clock_timestamp())
FROM "_weaver_duplicate_oauth_consents" AS duplicate
WHERE duplicate."referenceId" IS NOT NULL
  AND token."referenceId" = duplicate."referenceId";

DELETE FROM "OauthConsent" AS consent
USING "_weaver_duplicate_oauth_consents" AS duplicate
WHERE consent."id" = duplicate."id";

DROP TABLE "_weaver_duplicate_oauth_consents";

CREATE UNIQUE INDEX "OauthConsent_userId_clientId_key"
ON "OauthConsent"("userId", "clientId");

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "weaver_bind_oauth_authorization_code"()
RETURNS trigger AS $$
DECLARE
  payload JSONB;
  authorization_id TEXT;
  authorization_user_id TEXT;
  authorization_client_id TEXT;
  requested_scopes TEXT[] := ARRAY[]::text[];
  requested_resources TEXT[] := ARRAY[]::text[];
  resource_value JSONB;
BEGIN
  BEGIN
    payload := NEW."value"::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  IF payload->>'type' IS DISTINCT FROM 'authorization_code' THEN
    RETURN NEW;
  END IF;

  payload := payload - 'referenceId';
  authorization_user_id := payload->>'userId';
  authorization_client_id := payload #>> '{query,client_id}';
  IF authorization_user_id IS NULL OR authorization_client_id IS NULL THEN
    NEW."value" := payload::text;
    RETURN NEW;
  END IF;

  IF trim(COALESCE(payload #>> '{query,scope}', '')) <> '' THEN
    requested_scopes := regexp_split_to_array(
      trim(payload #>> '{query,scope}'),
      '\s+'
    );
  END IF;

  resource_value := payload #> '{query,resource}';
  IF jsonb_typeof(resource_value) = 'array' THEN
    requested_resources := ARRAY(
      SELECT jsonb_array_elements_text(resource_value)
    );
  ELSIF jsonb_typeof(resource_value) = 'string' THEN
    requested_resources := ARRAY[payload #>> '{query,resource}'];
  END IF;

  SELECT consent."referenceId"
  INTO authorization_id
  FROM "OauthConsent" AS consent
  WHERE consent."userId"::text = authorization_user_id
    AND consent."clientId" = authorization_client_id
    AND consent."referenceId" IS NOT NULL
    AND consent."scopes" @> requested_scopes
    AND consent."resources" @> requested_resources
  LIMIT 1
  FOR UPDATE;

  IF authorization_id IS NOT NULL THEN
    payload := jsonb_set(
      payload,
      '{referenceId}',
      to_jsonb(authorization_id),
      true
    );
  END IF;
  NEW."value" := payload::text;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "weaver_validate_oauth_refresh_generation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."referenceId" IS NULL THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "OauthConsent" AS consent
  WHERE consent."userId" = NEW."userId"
    AND consent."clientId" = NEW."clientId"
    AND consent."referenceId" = NEW."referenceId"
  FOR UPDATE;

  IF NOT FOUND THEN
    NEW."revoked" := COALESCE(NEW."revoked", clock_timestamp());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION "weaver_oauth_authorization_lock"(TEXT);
