-- Prior duplicate-pair history was discarded, so rotate every pre-safety generation fail closed.

BEGIN;

CREATE TEMP TABLE "_weaver_oauth_safety_cutoff" ON COMMIT DROP AS
SELECT max("finished_at") AS "finishedAt"
FROM "_prisma_migrations"
WHERE "migration_name" = '20260906110000_oauth_consent_generation_safety'
  AND "rolled_back_at" IS NULL
  AND "finished_at" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "_weaver_oauth_safety_cutoff"
    WHERE "finishedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'OAuth consent safety migration completion is unavailable';
  END IF;
END;
$$;

CREATE TEMP TABLE "_weaver_oauth_legacy_generations" ON COMMIT DROP AS
SELECT DISTINCT legacy."referenceId"
FROM (
  SELECT consent."referenceId"
  FROM "OauthConsent" AS consent
  CROSS JOIN "_weaver_oauth_safety_cutoff" AS cutoff
  WHERE consent."referenceId" IS NOT NULL
    AND (
      consent."createdAt" IS NULL
      OR consent."createdAt" <= cutoff."finishedAt"
    )

  UNION ALL

  SELECT token."referenceId"
  FROM "OauthRefreshToken" AS token
  CROSS JOIN "_weaver_oauth_safety_cutoff" AS cutoff
  WHERE token."referenceId" IS NOT NULL
    AND (
      token."createdAt" IS NULL
      OR token."createdAt" <= cutoff."finishedAt"
    )

  UNION ALL

  SELECT token."referenceId"
  FROM "OauthAccessToken" AS token
  CROSS JOIN "_weaver_oauth_safety_cutoff" AS cutoff
  WHERE token."referenceId" IS NOT NULL
    AND (
      token."createdAt" IS NULL
      OR token."createdAt" <= cutoff."finishedAt"
    )
) AS legacy;

DROP TRIGGER "OauthConsent_assign_generation" ON "OauthConsent";

UPDATE "OauthConsent" AS consent
SET "referenceId" = gen_random_uuid()::text
FROM "_weaver_oauth_safety_cutoff" AS cutoff
WHERE consent."referenceId" IN (
    SELECT legacy."referenceId"
    FROM "_weaver_oauth_legacy_generations" AS legacy
  )
  AND (
    consent."createdAt" IS NULL
    OR consent."createdAt" <= cutoff."finishedAt"
  );

CREATE TRIGGER "OauthConsent_assign_generation"
BEFORE INSERT OR UPDATE ON "OauthConsent"
FOR EACH ROW EXECUTE FUNCTION "weaver_assign_oauth_consent_generation"();

UPDATE "OauthRefreshToken" AS token
SET "revoked" = COALESCE(token."revoked", clock_timestamp())
FROM "_weaver_oauth_safety_cutoff" AS cutoff
WHERE token."revoked" IS NULL
  AND (
    token."referenceId" IS NULL
    OR token."referenceId" IN (
      SELECT legacy."referenceId"
      FROM "_weaver_oauth_legacy_generations" AS legacy
    )
    OR token."createdAt" IS NULL
    OR token."createdAt" <= cutoff."finishedAt"
  );

UPDATE "OauthAccessToken" AS token
SET "revoked" = COALESCE(token."revoked", clock_timestamp())
FROM "_weaver_oauth_safety_cutoff" AS cutoff
WHERE token."revoked" IS NULL
  AND (
    token."referenceId" IS NULL
    OR token."referenceId" IN (
      SELECT legacy."referenceId"
      FROM "_weaver_oauth_legacy_generations" AS legacy
    )
    OR token."createdAt" IS NULL
    OR token."createdAt" <= cutoff."finishedAt"
  );

COMMIT;
