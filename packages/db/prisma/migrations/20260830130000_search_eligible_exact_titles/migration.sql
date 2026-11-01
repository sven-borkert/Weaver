-- Exact-title candidates are indexed only while their derived search state
-- matches the current live source projection.
ALTER TABLE "DocumentIndexState"
  ADD COLUMN "exactTitle" TEXT,
  ADD COLUMN "exactNormalizedTitle" TEXT COLLATE "C"
  GENERATED ALWAYS AS (
    btrim(
      regexp_replace(
        lower(normalize("exactTitle", NFKC) COLLATE "und-x-icu"),
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ',
        'g'
      ),
      ' '
    )
  ) STORED,
  ADD COLUMN "exactNormalizedTitleHash" BYTEA
  GENERATED ALWAYS AS (
    digest(
      btrim(
        regexp_replace(
          lower(normalize("exactTitle", NFKC) COLLATE "und-x-icu"),
          U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
          ' ',
          'g'
        ),
        ' '
      ),
      'sha256'
    )
  ) STORED;

ALTER TABLE "TableSearchProjection"
  ADD COLUMN "exactTitle" TEXT,
  ADD COLUMN "exactNormalizedTitle" TEXT COLLATE "C"
  GENERATED ALWAYS AS (
    btrim(
      regexp_replace(
        lower(normalize("exactTitle", NFKC) COLLATE "und-x-icu"),
        U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
        ' ',
        'g'
      ),
      ' '
    )
  ) STORED,
  ADD COLUMN "exactNormalizedTitleHash" BYTEA
  GENERATED ALWAYS AS (
    digest(
      btrim(
        regexp_replace(
          lower(normalize("exactTitle", NFKC) COLLATE "und-x-icu"),
          U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
          ' ',
          'g'
        ),
        ' '
      ),
      'sha256'
    )
  ) STORED;

CREATE OR REPLACE FUNCTION "weaver_set_document_exact_title"()
RETURNS trigger AS $$
DECLARE
  current_title TEXT;
BEGIN
  IF NEW."status" = 'ready'
     AND NEW."keywordIndexedSha" IS NOT NULL
     AND NEW."keywordIndexedSha" = NEW."targetSha" THEN
    SELECT document."title"
    INTO current_title
    FROM "Document" AS document
    WHERE document."id" = NEW."documentId"
      AND document."projectId" = NEW."projectId"
      AND document."headCommitSha" = NEW."targetSha";
  END IF;

  NEW."exactTitle" := current_title;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentIndexState_set_exact_title"
BEFORE INSERT OR UPDATE ON "DocumentIndexState"
FOR EACH ROW EXECUTE FUNCTION "weaver_set_document_exact_title"();

CREATE OR REPLACE FUNCTION "weaver_set_table_exact_title"()
RETURNS trigger AS $$
DECLARE
  current_title TEXT;
BEGIN
  SELECT table_row."title"
  INTO current_title
  FROM "DataTable" AS table_row
  WHERE table_row."id" = NEW."tableId"
    AND table_row."projectId" = NEW."projectId"
    AND table_row."headCommitSha" = NEW."sourceCommitSha"
    AND table_row."title" = NEW."title";

  NEW."exactTitle" := current_title;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TableSearchProjection_set_exact_title"
BEFORE INSERT OR UPDATE ON "TableSearchProjection"
FOR EACH ROW EXECUTE FUNCTION "weaver_set_table_exact_title"();

CREATE OR REPLACE FUNCTION "weaver_refresh_document_exact_title"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "DocumentIndexState"
    SET "exactTitle" = NULL
    WHERE "documentId" = OLD."id";
    RETURN OLD;
  END IF;

  UPDATE "DocumentIndexState"
  SET "exactTitle" = NULL
  WHERE "documentId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Document_refresh_exact_title_update"
AFTER UPDATE OF "projectId", "headCommitSha", "title" ON "Document"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_document_exact_title"();

CREATE TRIGGER "Document_refresh_exact_title_delete"
AFTER DELETE ON "Document"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_document_exact_title"();

CREATE OR REPLACE FUNCTION "weaver_refresh_table_exact_title"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "TableSearchProjection"
    SET "exactTitle" = NULL
    WHERE "tableId" = OLD."id";
    RETURN OLD;
  END IF;

  UPDATE "TableSearchProjection"
  SET "exactTitle" = NULL
  WHERE "tableId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DataTable_refresh_exact_title_update"
AFTER UPDATE OF "projectId", "headCommitSha", "title" ON "DataTable"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_table_exact_title"();

CREATE TRIGGER "DataTable_refresh_exact_title_delete"
AFTER DELETE ON "DataTable"
FOR EACH ROW EXECUTE FUNCTION "weaver_refresh_table_exact_title"();

-- Existing rows are reconciled through the same trigger-owned invariant.
UPDATE "DocumentIndexState" SET "exactTitle" = NULL;
UPDATE "TableSearchProjection" SET "exactTitle" = NULL;

CREATE INDEX "DocumentIndexState_exact_title_idx"
  ON "DocumentIndexState"
    ("projectId", "exactNormalizedTitleHash", "exactTitle", "documentId");

CREATE INDEX "TableSearchProjection_exact_title_idx"
  ON "TableSearchProjection"
    ("projectId", "exactNormalizedTitleHash", "exactTitle", "tableId");
