-- Source identity transitions must invalidate the old derived identity and
-- publish any matching new identity in the same transaction.
CREATE OR REPLACE FUNCTION "weaver_refresh_document_exact_title"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "DocumentIndexState"
    SET "exactTitle" = NULL
    WHERE "documentId" = OLD."id";
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE "DocumentIndexState"
    SET "exactTitle" = NULL
    WHERE "documentId" = NEW."id";
    RETURN NEW;
  END IF;

  UPDATE "DocumentIndexState"
  SET "exactTitle" = NULL
  WHERE "documentId" IN (OLD."id", NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "weaver_refresh_table_exact_title"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "TableSearchProjection"
    SET "exactTitle" = NULL
    WHERE "tableId" = OLD."id";
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    UPDATE "TableSearchProjection"
    SET "exactTitle" = NULL
    WHERE "tableId" = NEW."id";
    RETURN NEW;
  END IF;

  UPDATE "TableSearchProjection"
  SET "exactTitle" = NULL
  WHERE "tableId" IN (OLD."id", NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Document_refresh_exact_title_update" ON "Document";
CREATE TRIGGER "Document_refresh_exact_title_update"
AFTER UPDATE OF "id", "projectId", "headCommitSha", "title" ON "Document"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_document_exact_title"();

DROP TRIGGER IF EXISTS "DataTable_refresh_exact_title_update" ON "DataTable";
CREATE TRIGGER "DataTable_refresh_exact_title_update"
AFTER UPDATE OF "id", "projectId", "headCommitSha", "title" ON "DataTable"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_table_exact_title"();

-- The prior insert-trigger migration had a deployment window after its
-- backfill. Reconcile again only after every corrected trigger is installed.
UPDATE "DocumentIndexState" SET "exactTitle" = NULL;
UPDATE "TableSearchProjection" SET "exactTitle" = NULL;
