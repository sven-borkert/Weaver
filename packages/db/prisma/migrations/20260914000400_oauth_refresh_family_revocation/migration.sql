CREATE FUNCTION weaver_invalidate_deleted_refresh_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."expiresAt" > timezone('UTC', now()) THEN
    DELETE FROM "OauthConsent"
    WHERE "userId" = OLD."userId"
      AND "clientId" = OLD."clientId"
      AND "referenceId" = OLD."referenceId";
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "OauthRefreshToken_invalidate_deleted_generation"
AFTER DELETE ON "OauthRefreshToken"
FOR EACH ROW EXECUTE FUNCTION weaver_invalidate_deleted_refresh_generation();
