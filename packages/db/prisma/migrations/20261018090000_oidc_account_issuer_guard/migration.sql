CREATE FUNCTION weaver_guard_oidc_account_issuer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  configured_issuer text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('weaver:oidc-settings', 0));
  SELECT value #>> '{discovery,metadata,issuer}' INTO configured_issuer
    FROM "SystemSetting" WHERE key = 'auth.oidc';
  IF FOUND AND configured_issuer IS DISTINCT FROM NEW.issuer THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'OIDC issuer changed before account creation; sign in again';
  END IF;
  RETURN NEW;
END;
$$;

-- Account insertion and provider replacement must share the settings transaction lock.
CREATE TRIGGER "Account_oidc_issuer_guard"
BEFORE INSERT OR UPDATE OF issuer, "providerId" ON "Account"
FOR EACH ROW WHEN (NEW."providerId" = 'oidc')
EXECUTE FUNCTION weaver_guard_oidc_account_issuer();
